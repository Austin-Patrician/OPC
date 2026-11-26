#!/usr/bin/env python3
"""Generate transparent multi-platform OPC Agent Brand icons from Buddy assets."""

from __future__ import annotations

import importlib.util
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / 'build'
PUBLIC_DIR = ROOT / 'apps' / 'renderer' / 'public'
BUDDY_STATIC = ROOT / 'apps' / 'renderer' / 'src' / 'assets' / 'buddy' / 'static.webp'
RAW_BASE_JPG = ROOT / 'vedios' / 'base.jpg'
BUDDY_SCRIPT = ROOT / 'scripts' / 'build-buddy-assets.py'

CANVAS = 1024
ICO_SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]


def load_bear_rgba() -> Image.Image:
    """Prefer high-resolution studio source vedios/base.jpg when available."""
    if RAW_BASE_JPG.exists() and BUDDY_SCRIPT.exists():
        spec = importlib.util.spec_from_file_location('build_buddy_assets', BUDDY_SCRIPT)
        if spec and spec.loader:
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            base_rgb = np.array(Image.open(RAW_BASE_JPG).convert('RGB'))
            bg_rgb = mod.sample_bg_color(base_rgb)
            rgba = mod.matte_frame(base_rgb, bg_rgb)
            im = Image.fromarray(rgba, mode='RGBA')
        else:
            im = Image.open(BUDDY_STATIC).convert('RGBA')
    elif BUDDY_STATIC.exists():
        im = Image.open(BUDDY_STATIC).convert('RGBA')
    else:
        raise FileNotFoundError('Neither vedios/base.jpg nor static.webp was found')

    alpha = np.array(im.getchannel('A'))
    ys, xs = np.where(alpha > 20)
    if len(ys) == 0:
        raise RuntimeError('Empty bear foreground')
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    return im.crop(bbox)


def render_brand_icon() -> Image.Image:
    bear = load_bear_rgba()
    target_h = round(CANVAS * 0.88)
    scale = target_h / bear.height
    bear_w = max(1, round(bear.width * scale))
    bear_h = max(1, round(bear.height * scale))
    bear_resized = bear.resize((bear_w, bear_h), Image.Resampling.LANCZOS)

    paste_x = round((CANVAS - bear_w) / 2)
    paste_y = round((CANVAS - bear_h) / 2)

    fg = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    fg.paste(bear_resized, (paste_x, paste_y), bear_resized)

    # Very subtle neutral contour halo so white fur stays legible on bright light taskbars
    # without adding any boxed background.
    alpha_ch = fg.getchannel('A')
    halo_alpha = alpha_ch.filter(ImageFilter.GaussianBlur(radius=10))
    halo_arr = np.zeros((CANVAS, CANVAS, 4), dtype=np.uint8)
    halo_arr[..., 0] = 24
    halo_arr[..., 1] = 24
    halo_arr[..., 2] = 28
    halo_arr[..., 3] = np.clip(np.array(halo_alpha, dtype=np.float32) * 0.22, 0, 255).astype(
        np.uint8
    )
    halo = Image.fromarray(halo_arr, mode='RGBA')

    halo_shifted = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
    halo_shifted.paste(halo, (0, 6), halo)

    return Image.alpha_composite(halo_shifted, fg)


def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    master = render_brand_icon()
    icon_512 = master.resize((512, 512), Image.Resampling.LANCZOS)
    icon_512.save(BUILD_DIR / 'icon.png', format='PNG', optimize=True)

    master.save(BUILD_DIR / 'icon.ico', format='ICO', sizes=ICO_SIZES)

    favicon = master.resize((128, 128), Image.Resampling.LANCZOS)
    favicon.save(PUBLIC_DIR / 'favicon.png', format='PNG', optimize=True)

    print(
        f'Generated transparent brand icons: build/icon.png ({(BUILD_DIR / "icon.png").stat().st_size} B), '
        f'build/icon.ico ({(BUILD_DIR / "icon.ico").stat().st_size} B), '
        f'apps/renderer/public/favicon.png ({(PUBLIC_DIR / "favicon.png").stat().st_size} B)'
    )


if __name__ == '__main__':
    main()
