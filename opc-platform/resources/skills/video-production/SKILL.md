---
name: video-production
title: 视频制作工作流
summary: 端到端 AI 视频制作工作流，串联分镜规划、关键帧锚定、图生视频、TTS 配音与 FFmpeg 质检合成。
category: creative
description: >
  End-to-end video production workflow combining AI video generation (generate_video),
  keyframe anchoring (generate_image), voiceover/TTS (text_to_speech), FFmpeg visual QA,
  and multi-shot post-production assembly. Use when creating promotional videos, product demos,
  short films, explainer videos, social reels, or multi-scene AI videos.
---

# Video Production Workflow

Follow this structured production SOP whenever the user asks to create, edit, or assemble a video deliverable.

## Track Selection (Dual-Track Routing)

Choose the right production track at the start:

- **Track A — AI Cinematic / Multi-Shot Narrative** (product showcase, ad, short film, brand trailer, visual B-roll):
  Lead with Storyboard + Asset Lock → `generate_image` anchor keyframes → `generate_video(imagePath=...)` I2V clips → FFmpeg visual QA → FFmpeg concat/xfade + audio/BGM mix.
- **Track B — Narrated Explainer / Motion-Graphics / Social Reel** (tutorial, pitch deck reel, news brief, lyric/quote reel):
  Lead with **TTS-first timing**: write script beats → generate voiceover with `text_to_speech` first → measure exact audio duration via `ffprobe` → build visuals/slides/B-roll to match those exact beat durations → composite deterministic crisp titles/subtitles via FFmpeg (`drawtext`/`subtitles`) + selective AI B-roll.

> **Never bake dense readable text inside AI video prompts.** AI video models hallucinate fine typography. Generate clean visual plates and burn titles, subtitles, and callouts deterministically in post-production.

---

## Stage 1 — Brief, Shot List & Cost Confirmation Gate

1. Clarify (or infer sensibly from context) **aspect ratio** (`16:9` landscape, `9:16` vertical short, `1:1` square), **target length**, **language**, and **visual style**.
2. Plan a concrete **Shot List** (`Shot # | Duration | Mode (T2V / I2V / Motion Plate) | Camera & Action | Audio/VO`).
3. **Cost Guardrail (Mandatory)**:
   - **Single clip (1 generation)**: proceed directly unless the user asked for confirmation.
   - **Multi-shot (>1 `generate_video` calls)**: present the concise shot table (shot count, per-clip duration, resolution/aspect ratio, T2V/I2V plan) to the user and obtain confirmation **before** running batch generation.

---

## Stage 2 — Style Bible & Asset Lock (Consistency First)

For any multi-shot video with recurring characters, products, or environments:

1. Write a compact **Style Bible** (consistent lens, lighting, palette, era, aspect ratio) and paste its core style tokens into every shot prompt.
2. **Generate anchor keyframes first with `generate_image`** (if available), saving into `./frames/` (for example `frames/hero-ref.png`, `frames/shot1-start.png`):
   - One character/product reference sheet ensures visual continuity across scenes.
   - Inspect generated keyframes before spending video credits.

---

## Stage 3 — Shot Generation (`generate_video`)

Read [`references/model-prompting.md`](references/model-prompting.md) before writing prompts for complex models (Seedance 2.5, Kling 3.0, MiniMax H3, Veo 3.1, Sora 2).

Key execution rules:
- **Prefer I2V (`imagePath`)** whenever composition, product silhouette, or character appearance matters. Keep the I2V prompt focused on **motion, camera trajectory, and temporal change**—do not re-describe static details already locked in the start image.
- Use **`endImagePath`** when a controlled morph or start-to-end camera reveal is required (for supported models like Veo 3.1 First-Last Frame, Kling, Seedance).
- Use `generateAudio: true` only for shots needing environmental SFX/dialogue; otherwise keep `generateAudio: false` and layer clean voiceover + BGM in Stage 5.
- Write each raw shot to `./shots/shot-01.mp4`, `./shots/shot-02.mp4`, etc.

---

## Stage 4 — Automated Visual QA & Single-Shot Redo

Never blindly concatenate uninspected clips. Run a fast FFmpeg check via `bash`:

1. Inspect metadata (`ffprobe`) to verify width, height, fps, duration, and audio stream presence.
2. Extract 3 contact keyframes (start / middle / end) per clip into `./qa/` and visually inspect them (or verify continuity/artifacts) — see [`references/ffmpeg-postproduction.md`](references/ffmpeg-postproduction.md).
3. If a single shot has severe warping, frozen motion, or wrong framing, **redo only that shot** with adjusted camera/motion prompt before final assembly.

---

## Stage 5 — Audio Mix & Post-Production Assembly

Use the tested FFmpeg recipes in [`references/ffmpeg-postproduction.md`](references/ffmpeg-postproduction.md):

1. Normalize all clips to identical resolution, frame rate (`fps=30`), pixel format (`yuv420p`), and SAR before joining.
2. Join multi-shot clips using clean cuts or subtle `xfade` dissolves (`0.3s–0.5s`).
3. Layer narration (`text_to_speech`) and optional background music with automatic sidechain/volume ducking so speech stays intelligible.
4. Burn clean `.srt` captions or crisp title overlays via FFmpeg when text is needed.

---

## Stage 6 — Delivery

- Write the final master video to a clean workspace-relative path such as `./output/final.mp4` (and ensure final file size/duration verify cleanly with `ffprobe`).
- Reference the delivered `.mp4` path in your final summary so the user can play and download it inline in the conversation.
