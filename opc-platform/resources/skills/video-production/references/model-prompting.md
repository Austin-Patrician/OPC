# Model Prompting & Parameter Guide

## Universal Shot Prompt Formula

Structure every prompt with clear, filmable language (50–120 words max; avoid conflicting adjectives):

`[Subject & Core Action] + [Camera Framing & Movement] + [Environment & Lighting] + [Visual Style & Materiality] + [Pacing / Audio Cue]`

### Golden Rules
- **I2V (Image-to-Video) Motion-Only Rule**: When supplying `imagePath`, describe *what moves, how the camera moves, and what physics/lighting evolve over time*. Over-describing static appearance causes jitter or morphing.
- **One Camera Move Per Clip**: Choose one clean camera verb (`slow dolly-in`, `tracking shot left-to-right`, `handheld subtle push`, `static locked tripod`, `orbital arc`). Combining multiple opposing moves causes warping.
- **Physical Time Anchors**: Use concrete timing cues (`starts still, then slowly turns toward camera`, `gradual light sweep across the brushed aluminum surface`) for 5–10s clips.
- **Zero Dense Typography**: Describe clean surfaces and open negative space instead of asking the video model to spell slogans or UI tables.

---

## Provider / Model Cheat Sheets

### 1. 豆包 Seedance (`volcengine-ark` / `bytedance/seedance-2.5/*`)
- **Models**: `doubao-seedance-2-5-260628`, `doubao-seedance-2-5-flash-261115`, `doubao-seedance-2-0-260128`, `doubao-seedance-2-0-fast-260128`, `doubao-seedance-2-0-mini-260615`
- **Sweet Spot**: `duration: 5` or `10` (up to `30s` on 2.5 / 2.5 Flash), `resolution: '720p'` / `'1080p'` (Flash supports 480p/720p), `aspectRatio: '16:9'` or `'9:16'`.
- **Strengths**: Strong Mandarin & bilingual prompt comprehension, natural human physics, first/last frame (`imagePath` + `endImagePath`), synchronized `generateAudio: true`.
- **Tips**: Use `doubao-seedance-2-5-flash-261115` for fast iteration (~2x faster) and `doubao-seedance-2-5-260628` for final flagship shots; name lens focal length (`35mm cinematic lens`) and motion speed.

### 2. 可灵 Kling (`kling` / `kling/v4/*` / `fal-ai/kling-video/v3/pro/*`)
- **Models**: `kling-v4-0`, `kling-v4-0-flash`, `kling-3.0`, `kling-3.0-omni`, `kling-v2-6`
- **Sweet Spot**: `duration: 5` or `10` (4.0 supports up to `30s`, 4.0 Flash up to `20s`), supports `16:9`, `9:16`, `1:1`, `4:3`, `3:4`.
- **Strengths**: Flagship physics & micro-motion fidelity, native stereo audio (`generateAudio: true`), HDR/1080p+, product commercials, first-to-tail frame morphing (`endImagePath`).
- **Tips**: Default to `kling-v4-0` / `kling-v4-0-flash` for newest physics & stereo audio; use `negativePrompt` cleanly to prevent flicker (`blurry, distorted hands, morphing text, watermark, flicker`). For official Kling API keys, OPC accepts either relay Bearer tokens or `AccessKey:SecretKey`.

### 3. MiniMax / 海螺 (`minimax` / `minimax/h3-max/*`)
- **Models**: `MiniMax-H3`, `MiniMax-H3-Max`, `MiniMax-H3-Highspeed`, `MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-2.3-Fast`
- **Sweet Spot**: `duration: 6` or `10`, `resolution: '768p'` / `'1080p'`.
- **Strengths**: Expressive character facial acting, dramatic lighting, smooth stylized/anime and live-action camera arcs.
- **Tips**: Put emotional/acting micro-beats cleanly (`subtle smile, eyes widen slightly as warm rim light hits her face`).

### 4. Google Veo (`google` / `fal-ai/veo3.1/*`)
- **Models**: `veo-3.1-generate-001`, `veo-3.1-fast-generate-001`, `veo-3.1-lite-generate-001`, `fal-ai/veo3.1`, `fal-ai/veo3.1/fast/first-last-frame-to-video`
- **Sweet Spot**: `duration: 4`, `6`, or `8`, `aspectRatio: '16:9'` or `'9:16'`, `resolution: '720p'` / `'1080p'`.
- **Strengths**: Rich photorealistic cinematography + built-in synchronized dialogue, foley, and ambient audio (`generateAudio: true`).
- **Tips**: Describe ambient sound and dialogue explicitly when `generateAudio: true` (`Audio: crisp footsteps on wet cobblestone, distant city rain, soft cello swell`). Avoid `1:1` on direct Veo if `16:9`/`9:16` is required by endpoint.

### 5. Sora 2 / OpenAI-Compatible Gateways (`openai-video`)
- **Models**: `sora-2`, `sora-2-pro` (plus custom gateway model IDs)
- **Sweet Spot**: `duration: 4`, `8`, or `12`, `aspectRatio: '16:9'` / `'9:16'`.
- **Strengths**: Long coherent camera takes and complex multi-subject staging.
- **Tips**: Keep scene geometry unambiguous and specify foreground/midground/background layers clearly.
