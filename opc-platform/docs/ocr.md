# 内置 OCR（图片文字识别）

> 目标：任何员工——包括所用模型**没有视觉能力**的——都能读图片里的文字。
> 能力内置、离线、跨平台一致，不依赖系统 OCR，也不在首启时下载模型。

---

## 1. 为什么不走系统 OCR

| 方案 | 问题 |
| --- | --- |
| macOS Vision / Windows Media OCR | 两套 API、两套效果、两套错误模型；Linux 直接没有；结果不可复现，单测只能 mock |
| `onnxruntime-node` + 原生库 | 单平台二进制 30–45MB（包内全平台 293MB），打包净增 75–85MB |
| 首启下载模型 | 弱网/内网必出事故；「内置」本就该离线可用 |
| 云端 OCR API | 截图内容外发，且与现有代理配置纠缠 |

最终选择：**PP-OCRv5 mobile 模型 + `onnxruntime-web`，跑在专用隐藏渲染进程的 Web Worker 里**（WebGPU 优先，WASM 兜底）。三平台同一份代码、同一份模型、同一套结果。

## 2. 体积账单

| 项 | 体积 |
| --- | --- |
| `PP-OCRv5_mobile_det_infer.onnx` | 4.5 MB |
| `PP-OCRv5_mobile_rec_infer.onnx` | 15.8 MB |
| `ppocrv5_dict.txt`（18,385 行） | 72 KB |
| `ort-wasm-simd-threaded.jsep.wasm` | 22.7 MB |
| `ort-wasm-simd-threaded.jsep.mjs` | 49 KB |
| OCR 页面 JS（`worker` 345KB + `ppu-ocv` 41KB + 入口 0.5KB） | ≈ 390 KB |
| **打包净增** | **≈ 45 MB** |

对比原生方案省掉约 40MB，代价是多一层窗口生命周期与 worker 调度（已封装在 `OcrService` 内）。

模型与 wasm 都放在 asar **外面**（`extraResources`），因此不需要解包，`opc-ocr://` 协议直接流式读取。

## 3. 架构

```
WorkService.harnessFor
  └─ ocr_image 工具（apps/main/src/work/ocrTool.ts）
        │  工作区路径校验 / 格式 / 15MB / 截断
        ▼
OcrService（apps/main/src/ocr/service.ts，主进程）
  │  队列（并发 1）、就绪/请求超时、空闲 3 分钟销毁
  │  IPC: ocr:request / ocr:result
  ▼
隐藏 BrowserWindow（内存分区 opc-ocr，sandbox，无 Node）
  │  preload: ocr.cjs → window.opcOcr
  │  页面: opc-ocr://app/ocr.html（生产）/ Vite dev URL（开发）
  ▼
Web Worker（apps/renderer/src/ocr/worker.ts）
  │  onnxruntime-web：executionProviders ['webgpu','wasm']
  │  ppu-paddle-ocr：检测 → 方向修正 → 识别 → CTC 解码
  ▼
OcrResult { text, lines[{text, box, confidence}], confidence, width, height, engine, elapsedMs }
```

要点：

- **主进程不推理**。模型在渲染进程，主进程只做排队、超时与转发。
- **专用窗口**：`session.fromPartition('opc-ocr')`（内存态，不落盘），`webRequest.onBeforeRequest` 只允许 `opc-ocr://`（开发环境额外允许 dev server），所有权限请求一律拒绝。
- **按需创建**：第一次调用才建窗口（引擎初始化是慢的那部分），之后常驻，空闲 3 分钟销毁。
- **串行**：引擎只有一个 WASM 堆，`recognize()` 用 Promise 链串行化。

## 4. 资源与协议

### 资源脚本

模型不进 Git（`resources/ocr/{models,ort,manifest.json}` 已忽略）：

```bash
pnpm ocr:assets          # 下载/补齐（postinstall 会自动尝试，失败只警告）
node scripts/fetch-ocr-assets.mjs --check   # 仅校验（prebuild 调用，缺资源硬失败）
```

- 模型来源：`huggingface.co/snowfluke/ppu-paddle-ocr-models`，失败时回退 GitHub raw。
- 每个文件按 **字节数 + sha256** 校验（写在脚本常量与 `manifest.json` 里）。
- ORT 文件从 `node_modules/onnxruntime-web/dist` 复制，所以必须先 `pnpm install`。
- 校验只认 sha256，不看 mtime：已存在的正确文件不会重复下载。
- `pnpm build` 的 `prebuild` 会跑 `--check`，缺模型在构建期就报错，而不是等到第一次 OCR。

### `opc-ocr://` 协议

`apps/main/src/ocr/protocol.ts`：

| 路径 | 内容 |
| --- | --- |
| `opc-ocr://app/ocr.html`、`/assets/*` | `out/renderer` 下的页面与打包产物 |
| `opc-ocr://app/models/*` | `resources/ocr/models` |
| `opc-ocr://app/ort/*` | `resources/ocr/ort` |

- 三个根之外的路径一律 403（用 `path.relative` 判断，不靠字符串前缀）。
- 用 `createReadStream` 流式返回，并设置 `Content-Length`；用 `session.fetch(file://)` 会在 23MB wasm 上失败。
- HTML 响应头注入 CSP（`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'`）。开发环境不加 CSP，因为 Vite 的 React refresh 需要内联脚本。

## 5. 工具契约

```ts
ocr_image({
  path: string,        // 相对工作区，例如 screenshots/login.png
  detail?: 'text' | 'lines'   // 默认 text；lines 每行带 x,y,w,h 与置信度
})
```

返回（`text`）：

```
图片 900×420，4 行，置信度 96.4%，引擎 webgpu，耗时 1089ms

订单确认单Order #A1024
客户： 张三 Customer: Zhang San
...
```

返回（`lines`）：每行前缀 `[x,y 宽×高 置信度]`。

限制与行为：

| 项 | 值 |
| --- | --- |
| 路径 | 必须在工作区内；`..` 与指向外部的符号链接都拒绝（`realpath` 二次校验） |
| 格式 | png / jpg / jpeg / webp / bmp / tif / tiff / gif |
| 单文件 | ≤ 15MB |
| 图片尺寸 | 单边 ≤ 12000px、总像素 ≤ 4000 万 |
| 请求超时 | 90s（就绪超时 30s） |
| 输出 | ≤ 8000 字符，超出截断并说明总长度 |
| 空图 | 成功返回「未识别到文字」，不是错误 |
| 缓存 | 引擎常驻 + `ppu` 内部对同图命中缓存（重复识别 1–11ms） |

返回**文本而非图片块**：对无视觉模型省 token，结果还能被记录、检索、二次引用，也不会在压缩上下文时丢失。

工具对所有员工注册（不做模型能力判断）：视觉模型也能用它拿准确措辞，而按能力开关会让 harness 缓存失效、增加一类状态。

## 6. WebGPU 与回退

- 显式 `executionProviders: ['webgpu', 'wasm']`，**不先探测**。冷启动时 GPU 进程还没起来，第一次 `requestAdapter()` 可能返回 null，先探测会误判。
- ORT 自己会在 WebGPU session 建不起来时退到 wasm（`createSessionWithFallback`）。
- `engine` 字段回报实际使用的 provider（`webgpu` / `wasm`），出现在工具输出里，便于排查。
- 实测（Apple Silicon）：WebGPU 冷启 ≈ 1.0–1.4s，同图复跑 1–11ms；WASM 冷启 ≈ 1.4–1.5s。
- 隐藏窗口没有 cross-origin isolation → 无 `SharedArrayBuffer` → `ort.env.wasm.numThreads = 1`。

## 7. 识别参数（别乱动）

```ts
recognition: { minimumConfidence: 0.5, recBatchSize: 1, strategy: 'per-box' }
```

- `recBatchSize: 1` 是**必须**的：`ppu-paddle-ocr@6.6.1` 的批量识别会丢字/乱码，整行曾识别成 `[Tbr`；逐张推理与 Node 管线结果一致。
- `strategy: 'per-box'` 比 `per-line` 准：合并行框会把相距很远的列粘在一起。
- `minimumConfidence: 0.5` 丢掉图标、边框这类检测噪声。

## 8. 打包

```yaml
# electron-builder.yml
extraResources:
  - from: resources/ocr
    to: ocr
```

- 打包后路径 = `process.resourcesPath/ocr`；开发态 = `<repo>/resources/ocr`（`resolveOcrAssetsDir`）。
- 启动前 `assertOcrAssets()` 按 `manifest.json` 校验存在性与字节数，缺什么、跑什么命令都写在报错里。
- `pnpm pack:mac` 可验证 asar 外的资源与协议路径。

## 9. 依赖与许可

| 依赖 | 版本 | 许可 |
| --- | --- | --- |
| `ppu-paddle-ocr` | 6.6.1 | MIT |
| `ppu-ocv`（图形预处理，`canvas-web` 入口） | 4.0.0 | MIT |
| `onnxruntime-web`（jsep 构建） | 1.23.2 | MIT |
| PP-OCRv5 mobile 模型 | — | Apache-2.0（PaddleOCR） |

上线前把模型来源与许可写进 `NOTICE`。

## 10. 已知边界

- 仅识别**工作区内已有文件**：agent 自己截的图、用户放进工作区的图片、`generate_image` 的产物。仓库目前没有聊天图片上传/落盘链路，所以「粘贴一张图」暂不可用。
- 不做 PDF 与多页 TIFF；不做版面还原（表格结构只按行的先后顺序输出）。
- 竖排/旋转文字依赖检测器的方向分类，效果不如横排文档；必要时用 `detail='lines'` 看坐标自行判断顺序。
- 模型是「mobile」档：小字、低对比度截图的准确率明显低于 server 档。需要更高精度时换 `V5_SERVER_MODEL`，代价是模型从 21MB 涨到数百 MB。

## 11. 调试

```bash
# 端到端识别一张图（隐藏窗口 → 协议 → Worker → WebGPU）
OPC_OCR_PROBE=/abs/path/to.png npx electron .
OPC_OCR_PROBE=/abs/path/to.png OPC_OCR_PROBE_REPEAT=3 npx electron .
```

输出一行 `OCR_PROBE {json}`，包含 `engine`、`elapsedMs`、`confidence`、逐行 `box`。控制台里 `[ocr] console error/warning` 是 OCR 窗口的日志（含 ORT 的 `VerifyEachNodeIsAssignedToAnEp` 提示，属正常）。
