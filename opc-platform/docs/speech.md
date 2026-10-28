# 语音模型（ASR / TTS）

> 目标：员工能**听懂录音**（会议、语音备忘、访谈），也能**开口说话**（配音、音频摘要、旁白）。
> 模型走统一 Provider 体系，API Key 只留在主进程；首个接入方是 Xiaomi MiMo。

---

## 1. 为什么单独做一类能力

LLM 吃文本、Image 产图片，语音是**两个方向**：

| 能力 | 输入 | 输出 | 用途 |
| --- | --- | --- | --- |
| ASR（语音识别） | 音频 | 文本 | 会议记录、语音输入、访谈整理 |
| TTS（语音合成） | 文本 | 音频 | 朗读回复、配音、音频交付物 |

两者共用一个 Provider 的 Base URL 与 Key，所以设置页只有一个 **Voice** 页，用分段开关切换 ASR / TTS 视图。

## 2. 架构

```
Settings → Voice（apps/renderer/src/features/settings/ui/pages/VoicePage.tsx）
  └─ buildVoiceProviders()  目录 + 已存 provider 合并，按 capability 过滤
        │  开关 → setModels(capability, voiceEnabled)
        ▼
ModelConfigService（default.asr / default.tts）
        │
        ├─ 麦克风：useVoiceRecorder → 16kHz WAV → IPC speech:transcribe
        └─ 朗读：SpeakButton → IPC speech:synthesize
              ▼
SpeechService（apps/main/src/models/speechService.ts）
  │  显式模型 → 默认模型 → 有 Key 的可用模型
  ▼
speech.ts（apps/main/src/models/speech.ts）
  ├─ xiaomi-audio  → /chat/completions（input_audio / assistant + audio）
  └─ openai-audio  → /audio/transcriptions、/audio/speech
```

Agent 侧：

```
WorkService.harnessFor
  ├─ transcribe_audio（仅当 ASR 可用时安装）
  └─ text_to_speech （仅当 TTS 可用时安装）
        └─ apps/main/src/work/speechTool.ts
```

## 3. Provider 与模型

Xiaomi 的语音接口是 **[OI] 兼容的 `/v1/chat/completions`**，因此复用已有的 `xiaomi` provider 行（Base URL + Key），不需要新 Provider。

### 3.1 列表里出现哪些 Provider

规则只有一条：**必须真的拥有该角色的语音模型**（目录里带 `type: 'asr' | 'tts'`，或库里存了 `capability` 匹配的行）。

- LLM 页创建的自定义 Provider 是给 chat 用的，即使 `isCustom: true` 也不显示；
- 只有 TTS 模型的 Provider 不出现在 ASR 标签页，反之亦然；
- 例外：刚在本页点「添加 Provider」建好、还没有任何模型的那一行，通过 `includeProviderId`
  临时显示，否则创建完就消失，无法给它添加模型。切换 ASR/TTS 时该临时状态清空。

Image 页的 `buildImageProviders` 用的是同一条规则（此前新建的自定义 Provider 会立刻消失，已一并修掉）。

| 模型 | 类型 | 说明 |
| --- | --- | --- |
| `mimo-v2.5-asr` | ASR | 中/英，`asr_options.language` 支持 `auto`/`zh`/`en` |
| `mimo-v2.5-tts` | TTS | 预置音色：`mimo_default`、冰糖、茉莉、苏打、白桦、Mia、Chloe、Milo、Dean |
| `mimo-v2.5-tts-voiceclone` | TTS | 需要音频样本（base64）作为 `audio.voice` |
| `mimo-v2.5-tts-voicedesign` | TTS | 用 user message 描述音色；不接受 `audio.voice` |

`catalog.ts` 里以 `DIRECT_VOICE_MODELS` 挂在 `xiaomi` 下，`api: 'xiaomi-audio'`。pi 的目录里没有语音模型，所以这里手写；即使 pi 后续改名/删掉 provider，末尾的兜底循环仍会让它可配置。

**只用按量计费的 `xiaomi` Key**：语音模型没有挂到 `xiaomi-token-plan-*`，套餐额度不覆盖语音。

## 4. 启用状态：`voiceEnabled`

`capability` 只说明模型「是什么」，不说明「是否启用」。原因和 Image 一样：LLM 页会把 provider 的整个目录落库，语音模型也会被写成 `chat` 行；单看「行存在」会误判为可用。

| 字段 | 含义 |
| --- | --- |
| `capability: 'asr' \| 'tts'` | 这个 id 属于哪一类语音能力 |
| `voiceEnabled: true` | Voice 页的开关已打开，运行时可以解析到它 |

解析规则：`model.capability === role && model.voiceEnabled === true`。
`ModelConfigService.setModels` 会保留这两个字段，所以改价格、改名、重新导入都不会悄悄关掉模型。

## 5. 工具契约

```ts
transcribe_audio({
  path: string,                    // 相对工作区，例如 recordings/standup.mp3
  language?: 'auto' | 'zh' | 'en'   // 默认 auto
})

text_to_speech({
  text: string,                    // 要朗读的原文
  filename?: string,               // 默认 speech-<ts>.mp3
  voice?: string,                  // 预置音色 id
  format?: 'mp3' | 'wav'           // 默认 mp3
})
```

返回：

```
转写完成：recordings/standup.mp3，12 秒音频，模型 mimo-v2.5-asr

今天先过一遍进度，然后看两个风险点……
```

```
已生成 intro.mp3（48210 B，96 字符，模型 mimo-v2.5-tts）
```

限制：

| 项 | 值 |
| --- | --- |
| 音频路径 | 必须在工作区内；`..` 与指向外部的符号链接都拒绝（`realpath` 二次校验） |
| 音频格式 | mp3 / wav / m4a / webm / ogg / flac（Xiaomi 只收 mp3/wav，其余需转换） |
| 音频大小 | ≤ 25MB（Xiaomi 上下文 8k，约 20 分钟） |
| 转写输出 | ≤ 12000 字符内联；更长时全文写入 `<音频名>.transcript.md`，只回前 12000 字符 |
| 合成文本 | ≤ 4000 字符，超出**拒绝**而不是截断（截断会读出半句话） |
| 输出文件名 | 拍平成单层（目录被剥掉），缺扩展名时按格式补 |

工具按可用性安装：只有 ASR 时只装 `transcribe_audio`，只有 TTS 时只装 `text_to_speech`，都没有就不装。模型永远不会看到一个注定失败的工具。

## 6. 麦克风输入

`MediaRecorder` 在 Chromium 里产出 **webm/opus**，而 Xiaomi 只收 mp3/wav，因此渲染进程做了转码：

1. `getUserMedia` 录音，最长 120 秒自动停止；
2. `AudioContext.decodeAudioData` 解码；
3. `OfflineAudioContext` 重采样到 16kHz 单声道；
4. 手写 16-bit PCM WAV 头（`encodeWav`），不引入 ffmpeg。

转写结果追加到输入框末尾（不覆盖已输入的文字）。ASR 的 Key 不会进入渲染进程：音频字节经 IPC 交给主进程。

## 7. 计费

| 能力 | 计价 |
| --- | --- |
| ASR | 按音频时长（Xiaomi ¥0.5/小时） |
| TTS | Xiaomi 当前限时免费 |

语音模型不按 token 计价，所以 Voice 页**不显示价格列**，只保留一句说明——避免把「USD / 1M tokens」套到按小时计费的模型上。

## 8. 验证

```bash
pnpm test apps/main/src/models/speech.test.ts          # 协议：请求体 / 响应解析 / 错误分支
pnpm test apps/main/src/models/speechService.test.ts   # 解析：默认模型 / 未启用 / 缺 Key
pnpm test apps/main/src/work/speechTool.test.ts        # 工具：路径 / 格式 / 大小 / 截断 / 落盘
pnpm test apps/renderer/src/features/settings/ui/pages/voiceProviders.test.ts
```

协议测试跑在本地 mock HTTP 上，不需要真实 Key：覆盖 Xiaomi ASR 的 `input_audio`、TTS 的 `assistant` 消息、voicedesign 分支、voiceclone 校验、[OI] 的 multipart 与二进制响应、HTTP 500 透传。

## 9. 已知边界

- **voiceclone 未开放 UI**：需要用户提供音频样本并转 base64；目前只能在 API 层调用，设置页没有上传入口。
- **voicedesign 用默认描述**：工具可以传 `voice` 作为音色描述，但 Voice 页没有单独的「音色设计」输入框。
- **不做流式**：`stream: false`，TTS 要等整段音频返回才播放；长文本体验上会有等待。
- **不落盘聊天录音**：麦克风录音只用于转写，不保存音频文件。
- **harness 缓存**：工具在 harness 首次创建时决定是否安装；启用语音模型后，已有员工的 harness 要等重建才会拿到新工具（与 `generate_image` 的行为一致）。
