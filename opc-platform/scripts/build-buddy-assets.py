#!/usr/bin/env python3
"""Process raw Buddy polar-bear videos in vedios/ into transparent animated WebP assets."""

from __future__ import annotations

from collections import deque
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / 'vedios'
OUT_DIR = ROOT / 'apps' / 'renderer' / 'src' / 'assets' / 'buddy'
PUBLIC_DIR = ROOT / 'apps' / 'renderer' / 'public'

OUTPUT_SIZE = 288
TARGET_STAND_H = 204
TARGET_BOTTOM = 266
TARGET_CX = OUTPUT_SIZE // 2

CLIPS = {
    'idle': {
        'ss': '2.0',
        'to': '5.0',
        'vf': 'fps=15',
        'fps': 15,
        'quality': 80,
    },
    'thinking': {
        'ss': '0.6',
        'to': '8.2',
        'vf': 'setpts=PTS/1.35,fps=14',
        'fps': 14,
        'quality': 78,
    },
    'working': {
        'ss': '1.0',
        'to': '4.0',
        'vf': 'fps=15',
        'fps': 15,
        'quality': 80,
    },
    'completed': {
        'ss': '0.8',
        'to': '5.1',
        'vf': 'setpts=PTS/1.2,fps=16',
        'fps': 16,
        'quality': 78,
    },
    'error': {
        'ss': '0.5',
        'to': '5.5',
        'vf': 'crop=1072:720:104:0,setpts=PTS/1.15,fps=15',
        'fps': 15,
        'quality': 78,
    },
}


def sample_bg_color(rgb: np.ndarray) -> np.ndarray:
    corners = np.concatenate(
        [
            rgb[:40, :40].reshape(-1, 3),
            rgb[:40, -40:].reshape(-1, 3),
        ],
        axis=0,
    )
    return np.median(corners, axis=0).astype(np.float32)


def exterior_flood_mask(candidate_bg: np.ndarray) -> np.ndarray:
    """Flood-fill from all 4 image edges through background candidates (1/2-res for speed)."""
    h, w = candidate_bg.shape
    dh, dw = max(1, h // 2), max(1, w // 2)
    small = (
        np.array(
            Image.fromarray(candidate_bg.astype(np.uint8) * 255, mode='L').resize(
                (dw, dh), Image.Resampling.BILINEAR
            )
        )
        > 127
    )

    ext = np.zeros_like(small, dtype=bool)
    q: deque[tuple[int, int]] = deque()
    for x in range(dw):
        if small[0, x] and not ext[0, x]:
            ext[0, x] = True
            q.append((0, x))
        if small[dh - 1, x] and not ext[dh - 1, x]:
            ext[dh - 1, x] = True
            q.append((dh - 1, x))
    for y in range(dh):
        if small[y, 0] and not ext[y, 0]:
            ext[y, 0] = True
            q.append((y, 0))
        if small[y, dw - 1] and not ext[y, dw - 1]:
            ext[y, dw - 1] = True
            q.append((y, dw - 1))

    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < dh and 0 <= nx < dw and small[ny, nx] and not ext[ny, nx]:
                ext[ny, nx] = True
                q.append((ny, nx))

    up = (
        np.array(
            Image.fromarray(ext.astype(np.uint8) * 255, mode='L').resize(
                (w, h), Image.Resampling.BILINEAR
            )
        )
        > 127
    )
    return up


def matte_frame(rgb: np.ndarray, bg_rgb: np.ndarray) -> np.ndarray:
    rgb_f = rgb.astype(np.float32)
    r = rgb_f[..., 0]
    g = rgb_f[..., 1]
    b = rgb_f[..., 2]

    blue_ex = b - np.maximum(r, g)

    # Interior vs exterior silhouette: exterior studio blue/floor-shadow has high blue_ex AND low R,
    # while interior shaded fur retains high R (>= 138) so interior hip/belly never gets punched out.
    bg_candidate = (blue_ex > 22.0) & (r < 138.0)
    exterior = exterior_flood_mask(bg_candidate)

    # Soft feather band only along pixels reachable from exterior background (~3-4px border)
    # Using dilated interior boundary so inner body stays 100% solid (alpha = 1.0).
    interior_im = Image.fromarray((~exterior).astype(np.uint8) * 255, mode='L')
    inner_solid = (
        np.array(interior_im.filter(ImageFilter.MinFilter(7)), dtype=np.float32) / 255.0 > 0.5
    )

    edge_alpha = np.clip((54.0 - blue_ex) / (54.0 - 16.0), 0.0, 1.0)
    edge_alpha = np.where(edge_alpha < 0.05, 0.0, edge_alpha) ** 1.15

    # Strictly exterior deep-blue gets alpha=0; strictly interior gets alpha=1; border gets feathered alpha
    alpha = np.where(inner_solid, 1.0, np.where(exterior, np.minimum(edge_alpha, 0.45), edge_alpha))

    # Color unmix + gentle blue despill on bear fur
    a_safe = np.maximum(alpha, 0.25)
    unmixed = np.clip(
        (rgb_f - (1.0 - alpha[..., None]) * bg_rgb[None, None, :]) / a_safe[..., None],
        0.0,
        255.0,
    )
    solid_blend = np.clip((alpha - 0.88) / 0.12, 0.0, 1.0)[..., None]
    fg = unmixed * (1.0 - solid_blend) + rgb_f * solid_blend

    # Despill blue bounce while lifting R/G gently on white edge fur
    limit_b = np.maximum(fg[..., 0], fg[..., 1]) + 1.0
    spill = np.maximum(0.0, fg[..., 2] - limit_b)
    fg[..., 2] = fg[..., 2] - spill
    lift = 0.28 * spill * (alpha > 0.08)
    fg[..., 0] = np.clip(fg[..., 0] + lift, 0.0, 255.0)
    fg[..., 1] = np.clip(fg[..., 1] + lift, 0.0, 255.0)

    # Ensure outer fur halo never dips into dark grey on light backgrounds
    outer_halo = (~inner_solid) & (alpha > 0.0) & (alpha < 0.9)
    floor_luma = np.maximum(fg[..., 0], np.maximum(fg[..., 1], fg[..., 2]))
    needs_clean = outer_halo & (floor_luma < 195.0)
    for ch, target in ((0, 238.0), (1, 232.0), (2, 228.0)):
        fg[..., ch] = np.where(needs_clean, np.maximum(fg[..., ch], target * 0.85), fg[..., ch])

    fg = np.where((alpha > 0.0)[..., None], fg, 0.0)
    rgba = np.empty((rgb.shape[0], rgb.shape[1], 4), dtype=np.uint8)
    rgba[..., :3] = np.clip(np.rint(fg), 0, 255).astype(np.uint8)
    rgba[..., 3] = np.clip(np.rint(alpha * 255.0), 0, 255).astype(np.uint8)
    return rgba


def measure_standing_bbox(rgba: np.ndarray) -> tuple[float, int, int]:
    ys, xs = np.where(rgba[..., 3] > 128)
    if len(ys) == 0:
        raise RuntimeError('Empty foreground detected in reference frame')
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    return (x0 + x1) / 2.0, y1, y1 - y0


def place_normalized(
    rgba: np.ndarray,
    stand_cx: float,
    stand_bottom: int,
    stand_h: int,
    canvas_size: int = OUTPUT_SIZE,
    target_h: int = TARGET_STAND_H,
    target_bottom: int = TARGET_BOTTOM,
    target_cx: int = TARGET_CX,
) -> Image.Image:
    scale = target_h / stand_h
    im = Image.fromarray(rgba, mode='RGBA')
    new_w = max(1, round(im.width * scale))
    new_h = max(1, round(im.height * scale))
    resized = im.resize((new_w, new_h), Image.Resampling.LANCZOS)

    paste_x = round(target_cx - stand_cx * scale)
    paste_y = round(target_bottom - stand_bottom * scale)
    canvas = Image.new('RGBA', (canvas_size, canvas_size), (0, 0, 0, 0))
    canvas.paste(resized, (paste_x, paste_y), resized)
    return canvas


def extract_frames(video_path: Path, ss: str, to: str, vf: str, work_dir: Path) -> list[Path]:
    work_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        'ffmpeg',
        '-y',
        '-v',
        'error',
        '-ss',
        ss,
        '-to',
        to,
        '-i',
        str(video_path),
        '-vf',
        vf,
        str(work_dir / 'f_%04d.png'),
    ]
    subprocess.run(cmd, check=True)
    return sorted(work_dir.glob('f_*.png'))


def build_static_and_favicon() -> tuple[Image.Image, Image.Image]:
    base_rgb = np.array(Image.open(SRC_DIR / 'base.jpg').convert('RGB'))
    bg_rgb = sample_bg_color(base_rgb)
    rgba = matte_frame(base_rgb, bg_rgb)
    stand_cx, stand_bottom, stand_h = measure_standing_bbox(rgba)
    static_img = place_normalized(rgba, stand_cx, stand_bottom, stand_h)
    static_img.save(
        OUT_DIR / 'static.webp',
        format='WEBP',
        quality=88,
        method=6,
    )

    fav = place_normalized(
        rgba,
        stand_cx,
        stand_bottom,
        stand_h,
        canvas_size=128,
        target_h=106,
        target_bottom=117,
        target_cx=64,
    )
    fav.save(PUBLIC_DIR / 'favicon.png', format='PNG', optimize=True)
    return static_img, fav


def build_verification_grid(samples: list[tuple[str, list[Image.Image]]], out_path: Path) -> None:
    cell = 180
    pad = 12
    cols = len(samples)
    rows = 4
    w = cols * cell + pad * 2
    h = rows * cell + 36
    canvas = Image.new('RGB', (w, h), (250, 249, 247))
    draw = ImageDraw.Draw(canvas)

    dark_y0 = 36 + 2 * cell
    draw.rectangle([0, dark_y0, w, h], fill=(21, 23, 28))

    for col, (label, imgs) in enumerate(samples):
        x0 = pad + col * cell
        draw.text((x0 + 8, 10), label, fill=(35, 35, 42))
        for pair_idx, img in enumerate(imgs):
            thumb = img.resize((cell - 12, cell - 12), Image.Resampling.LANCZOS)
            yl = 36 + pair_idx * cell + 6
            yd = dark_y0 + pair_idx * cell + 6
            canvas.paste(thumb, (x0 + 6, yl), thumb)
            canvas.paste(thumb, (x0 + 6, yd), thumb)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path, format='PNG')


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    tmp_root = Path(tempfile.mkdtemp(prefix='buddy-build-'))
    verify_path = Path(os.environ['TEMP']) / 'buddy-verify' / 'preview-grid.png'
    samples: list[tuple[str, list[Image.Image]]] = []

    try:
        static_img, fav_img = build_static_and_favicon()
        samples.append(('static', [static_img, static_img]))
        samples.append(('favicon', [fav_img, fav_img]))

        for name, cfg in CLIPS.items():
            frame_paths = extract_frames(
                SRC_DIR / f'{name}.mp4',
                str(cfg['ss']),
                str(cfg['to']),
                str(cfg['vf']),
                tmp_root / name,
            )
            if not frame_paths:
                raise RuntimeError(f'No frames extracted for {name}')

            first_rgb = np.array(Image.open(frame_paths[0]).convert('RGB'))
            bg_rgb = sample_bg_color(first_rgb)
            first_rgba = matte_frame(first_rgb, bg_rgb)
            stand_cx, stand_bottom, stand_h = measure_standing_bbox(first_rgba)

            out_frames: list[Image.Image] = []
            for idx, fp in enumerate(frame_paths):
                rgb = first_rgb if idx == 0 else np.array(Image.open(fp).convert('RGB'))
                rgba = first_rgba if idx == 0 else matte_frame(rgb, bg_rgb)
                out_frames.append(place_normalized(rgba, stand_cx, stand_bottom, stand_h))

            duration_ms = round(1000 / int(cfg['fps']))
            out_path = OUT_DIR / f'{name}.webp'
            out_frames[0].save(
                out_path,
                format='WEBP',
                save_all=True,
                append_images=out_frames[1:],
                loop=0,
                duration=duration_ms,
                quality=int(cfg['quality']),
                method=4,
                minimize_size=True,
            )

            mid = min(len(out_frames) - 1, max(1, len(out_frames) // 2))
            samples.append((name, [out_frames[0], out_frames[mid]]))
            print(
                f'{name:10s} frames={len(out_frames):2d} stand=({stand_cx:.1f}, bottom={stand_bottom}, h={stand_h}) '
                f'size={out_path.stat().st_size / 1024:.1f} KB'
            )

        print(f'{"static":10s} size={(OUT_DIR / "static.webp").stat().st_size / 1024:.1f} KB')
        print(f'{"favicon":10s} size={(PUBLIC_DIR / "favicon.png").stat().st_size / 1024:.1f} KB')
        total_kb = sum(p.stat().st_size for p in OUT_DIR.glob('*.webp')) / 1024
        print(f'total_webp size={total_kb:.1f} KB')

        build_verification_grid(samples, verify_path)
        print(f'verify_grid={verify_path}')
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == '__main__':
    main()
