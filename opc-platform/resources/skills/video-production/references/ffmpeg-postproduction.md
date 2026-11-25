# FFmpeg Post-Production & Visual QA Recipes

Use these verified commands via `bash` inside the task workspace. Always quote paths cleanly.

## 1. Check Tool Availability & Clip Metadata

```bash
ffmpeg -version | head -n 2
ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate -of json shots/shot-01.mp4
```

## 2. Extract 3 QA Keyframes (Start / Mid / End)

Inspect generated clips before assembly to catch morphing, frozen frames, or bad framing:

```bash
mkdir -p qa
DUR=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 shots/shot-01.mp4)
MID=$(node -e "console.log(Math.max(0.1, Number(process.argv[1]) * 0.5).toFixed(2))" "$DUR")
END=$(node -e "console.log(Math.max(0.2, Number(process.argv[1]) - 0.3).toFixed(2))" "$DUR")
ffmpeg -y -ss 0.15 -i shots/shot-01.mp4 -frames:v 1 qa/shot-01-start.jpg
ffmpeg -y -ss "$MID" -i shots/shot-01.mp4 -frames:v 1 qa/shot-01-mid.jpg
ffmpeg -y -ss "$END" -i shots/shot-01.mp4 -frames:v 1 qa/shot-01-end.jpg
```

## 3. Normalize Clips Before Concatenation

Different models or T2V/I2V runs may emit slightly different fps, SAR, or pixel formats. Normalize each shot to identical `1280x720` (or `1920x1080` / `1080x1920` for 9:16), `30fps`, `yuv420p`:

```bash
mkdir -p norm
for f in shots/shot-*.mp4; do
  base=$(basename "$f")
  ffmpeg -y -i "$f" \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1" \
    -c:v libx264 -preset medium -crf 18 -an \
    "norm/$base"
done
```

## 4. Concatenate Clips (Hard Cut vs Crossfade)

### Hard Cut (Concat Demuxer)

```bash
printf "file '%s'\n" norm/shot-*.mp4 > concat.txt
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy output/video-only.mp4
```

### Smooth Crossfade (`xfade`, 2+ normalized clips)

Example for two `5.0s` clips with `0.4s` dissolve (offset = `5.0 - 0.4 = 4.6`):

```bash
ffmpeg -y -i norm/shot-01.mp4 -i norm/shot-02.mp4 \
  -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.4:offset=4.6,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -preset medium -crf 18 output/video-only.mp4
```

## 5. Audio Mixing (Voiceover + Auto-Ducked BGM)

Combine narration (`vo.mp3` from `text_to_speech`) + BGM (`bgm.mp3` looped and ducked behind speech):

```bash
ffmpeg -y -i output/video-only.mp4 -i vo.mp3 -stream_loop -1 -i bgm.mp3 \
  -filter_complex "[2:a]volume=0.22[bg];[1:a]aresample=44100[vo];[bg][vo]sidechaincompress=threshold=0.02:ratio=6:attack=40:release=350[bgduck];[bgduck][vo]amix=inputs=2:duration=shortest:normalize=0[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest output/with-audio.mp4
```

If there is only narration (no BGM):

```bash
ffmpeg -y -i output/video-only.mp4 -i vo.mp3 \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest output/with-audio.mp4
```

## 6. Burn Clean Subtitles (`.srt`)

Ensure font legibility on 16:9 or 9:16 canvas:

```bash
ffmpeg -y -i output/with-audio.mp4 \
  -vf "subtitles=captions.srt:force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=36'" \
  -c:v libx264 -preset medium -crf 18 -c:a copy output/final.mp4
```

## 7. Generate a Crisp Title Card Plate (When Needed)

```bash
ffmpeg -y -f lavfi -i color=c=0x111827:s=1280x720:d=2.5 -r 30 \
  -vf "drawtext=text='Product Launch':fontcolor=white:fontsize=56:x=(w-text_w)/2:y=(h-text_h)/2,fade=t=in:st=0:d=0.4,fade=t=out:st=2.1:d=0.4,format=yuv420p" \
  -c:v libx264 -crf 18 norm/shot-00-title.mp4
```
