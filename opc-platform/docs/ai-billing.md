# AI 计费地基（设计阶段）

> 目标：**每一次 AI 调用都能稳定落到账上**，并且金额的计算方式可以选：
> 用服务商返回的 usage，还是用设置页里配置的模型单价。
> 本文只设计，不含实现。

---

## 0. 先回答两个问题

**Q：能不能保证每次调用都命中？**
能，但前提是换一个思路：不要依赖"调用成功后顺手记一笔"（会漏、会重复、会因崩溃丢），
而是把 **pi 的持久化日志当作账本的事实来源**，我们的 `ai_call` 表是它的**幂等投影**。
投影可以重放、可以补账，因此"漏记"从架构上被消除。

**Q：能不能既按返回的 usage、又按设置页的价格算？**
能，而且这是两件独立的事，必须拆开：

| 维度 | 事实来源（按优先级） |
| --- | --- |
| **用了多少 token** | 服务商返回的 `usage` → 本地估算（仅在服务商不返回时） |
| **这些 token 值多少钱** | 服务商上报的金额（若有）→ 设置页单价 → 内置目录单价 → 标记"无价格" |

现在的代码把两件事揉在一起了：`usage.cost` 其实是 **pi 用本地单价算出来的**，不是账单。
设计上要显式区分 `token_source` 与 `cost_source`，否则永远说不清"这个数字是谁说的"。

### 0.1 已锁定的口径

| # | 决定 |
| --- | --- |
| 1 | 失败 / 中断 / 报错的调用**一律计费**：按服务商实际返回的用量算，没有用量才是 0 |
| 2 | 对话、决策、语音、图像、记忆提炼、招聘试跑**全部计入员工成本**，用 `operation` 区分 |
| 3 | 定价默认 **provider 优先 + configured 兜底**（见 §4.1），两种策略都保留，页面可切 |
| 4 | 只做 **USD / CNY** 两种展示，手工汇率，不做多币种账本 |
| 5 | 历史账本回填成 **`legacy` 调用**，保证升级前后总额连续 |
| 6 | 汇率默认 **1 USD = 7.30 CNY**，可改；历史账单冻结入账时的汇率 |
| 7 | 语音/图像内置一份参考单价（OpenRouter，2026-11 抓取），provider 返回 `usage.cost` 时以 provider 为准 |

---

## 1. 现状盘点：为什么会漏、会算不准

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `work/harnessBrain.ts:59,89` | 取 `harness.usage()` 前后差 | 只能得到**任务级**汇总；并发/重试/子任务混在一起 |
| `work/harnessBrain.ts:104` | `reportUsage({ input: 0, output: 0, total })` | 输入输出拆分直接丢掉，缓存 token 也没传 |
| `work/harnessBrain.ts:125-135` | 有 pi cost 用 pi，否则 input/output 单价线性算 | 兜底路径**不算缓存、不算阶梯价**，与真实账单必然有偏差 |
| `work/workService.ts:225,228` | 只有验收通过才 `settle`，失败就 `release` | 失败/取消的任务**完全免费**，但 API 已经扣了钱 |
| `index.ts:309` `chat.replyWithModel` | 直接 `models.complete` | 对话一分钱不记 |
| `index.ts:272` 对话提炼 | 直接 `models.complete` | 记忆整理不记账 |
| `index.ts:351` 招聘试跑 | 记了 token，不进预算 | 试跑成本不进任何报表 |
| `models/decisionService.ts` | 返回了 usage 给界面 | 只展示，不记账 |
| `speech` / `image` | 各自的计价单位（秒 / 张） | 不进 `budget_ledger`，成本模型缺一整类 |
| `budget_ledger` | 一次 settle 往 4 条轴各写一行相同数字 | 是对的上限口径，但**没有调用级明细**：说不清钱花在哪个模型/哪次调用 |
| `work/payroll.ts:100` | 用 `cost / tokens` 反推单价 | 库里有真实单价却不用，只能"观测"，不能"定价" |

结论：不是"加个按钮"，而是**现在没有调用级账本**。要稳定命中，先补这一层。

---

## 2. 目标模型

```
一次 AI 调用  →  ai_call（事实，一行一次）
                    │
                    └─ ai_call_charge（这条调用命中了哪些预算轴：员工/部门/项目/公司）
```

`budget` / `budget_ledger` 继续负责**准入与硬停**，但不再承担"花了多少"的明细职责。
报表（薪酬、成本中心、账单页）统一从 `ai_call` 聚合。

### 2.1 `ai_call`

```sql
CREATE TABLE ai_call (
  id                 TEXT PRIMARY KEY,
  -- 幂等键：pi 的 entry id / 非 pi 调用的 request id / 自算 hash。
  idempotency_key    TEXT NOT NULL UNIQUE,
  -- 生命周期：调用前先写 running，结束再更新；崩溃留下的 running 由启动对账处理。
  status             TEXT NOT NULL CHECK (status IN ('running','ok','error','aborted','interrupted')),
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,

  -- 谁、为什么花
  employee_id        TEXT,
  department_id      TEXT,
  project_id         TEXT,
  task_id            TEXT,
  conversation_id    TEXT,
  operation          TEXT NOT NULL CHECK (operation IN (
                       'task','chat','summary','compaction','decision',
                       'speech_stt','speech_tts','image','embedding','trial','legacy','other')),
  origin             TEXT NOT NULL,      -- 'agent' | 'boss-chat' | 'system' | 'market' | 'tool'

  -- 用了什么
  provider_id        TEXT NOT NULL,
  model_id           TEXT NOT NULL,
  thinking_level     TEXT,
  attempt            INTEGER NOT NULL DEFAULT 1,

  -- usage（服务商口径）
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER,
  reasoning_tokens   INTEGER,            -- output 的子集，不算第二遍钱
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  token_source       TEXT NOT NULL CHECK (token_source IN ('provider','estimated','missing')),

  -- 计费量：token 之外的单位也要能复核
  billing_unit       TEXT NOT NULL DEFAULT 'token'
                       CHECK (billing_unit IN ('token','character','second','image','megapixel')),
  billed_quantity    REAL NOT NULL DEFAULT 0,   -- 字符数 / 秒数 / 张数 / 百万像素数

  -- money（三个数，各有含义）
  provider_cost_usd  REAL,               -- 服务商真的报了一个金额才有；否则 NULL
  configured_cost_usd REAL,              -- 用下单时快照的单价算出来的
  charged_cost_usd   REAL,               -- 最终入账口径（策略选择上面之一）
  cost_source        TEXT NOT NULL CHECK (cost_source IN
                       ('provider','configured','builtin','unpriced','legacy')),
  currency           TEXT NOT NULL DEFAULT 'USD',
  -- 入账当天 USD→CNY 的手工汇率；历史行不被后续改汇率影响。
  fx_rate            REAL,
  -- 下单那一刻的单价，冻结。之后改设置页不回溯历史。
  price_snapshot     TEXT,

  error              TEXT
);

CREATE INDEX idx_ai_call_time      ON ai_call(started_at DESC);
CREATE INDEX idx_ai_call_employee  ON ai_call(employee_id, started_at DESC);
CREATE INDEX idx_ai_call_task      ON ai_call(task_id);
CREATE INDEX idx_ai_call_model     ON ai_call(provider_id, model_id, started_at DESC);
CREATE INDEX idx_ai_call_unpriced  ON ai_call(started_at) WHERE cost_source = 'unpriced';
```

三个金额字段是刻意的：**能同时看到"服务商说多少"和"我们算多少"**，
差额就是定价表漂移的证据，而不是等月底对不上账再猜。

### 2.2 `ai_call_charge`

```sql
CREATE TABLE ai_call_charge (
  call_id   TEXT NOT NULL REFERENCES ai_call(id) ON DELETE CASCADE,
  scope     TEXT NOT NULL CHECK (scope IN ('employee','department','project','company')),
  scope_id  TEXT NOT NULL,
  tokens    INTEGER NOT NULL,
  cost_usd  REAL NOT NULL,
  PRIMARY KEY (call_id, scope, scope_id)
);
```

**注意口径**：这里每行是"这条调用算在该轴上的金额"，四条轴是**并列视图，不是拆分**。
报表永远只读一条轴（沿用 `payroll.ts` 现有注释里的原则），不存在把四条加起来的写法。

---

## 3. 如何保证"每次调用都命中"

### 3.1 pi 驱动的调用（任务、压缩）

pi 的每一次模型响应本来就是一条**持久化 entry**，`entry.model[].usage` 里带着完整的
`input / output / cacheRead / cacheWrite / reasoning / cost`。所以：

```
harness.watch(conversation)  /  message_end
        │
        └─ 读取 entry.model[].usage
              └─ UPSERT ai_call ON idempotency_key = entry.id
```

- **幂等**：`entry.id` 是天然主键。重放、重连、重复消费都只会更新同一行。
- **补账**：进程崩溃没关系——entry 在，启动时把"日志里有、账本里没有"的 entry 补写。
  这就是"稳定命中"的真正保障，而不是 try/catch 里记一笔。
- **压缩调用**：`UsageState` 把压缩摘要单独记在 `models` / `tools` 桶里，按其条目补
  `operation='compaction'`，不混进任务调用。
- **重试**：同一次生成的重试有独立的 attempt；`message_end` 每次都会落 entry，
  因此每次真实调用各一行，`attempt` 递增。

### 3.2 非 pi 的调用（对话、提炼、决策、语音、图像、向量、试跑）

把 `ModelConfigService.runtime.createModels()` 包一层 **MeteredRuntime**，
所有 `complete / classify / transcribe / speak / generateImage / embed` 从工厂出来就自带计量。
这样"忘记记账"不是靠自觉，而是**拿不到未计量的模型对象**。

```ts
const models = metered.createModels({ employeeId, projectId, operation: 'chat' });
// 返回的 complete() 内部：写 running → 调用 → 写 usage/cost → 写 ai_call_charge
```

配套一个静态检查（eslint 自定义规则或 `pnpm check:metering`）：
`apps/main/src` 里除 `models/metered*.ts` 外，不允许直接出现 `models.complete(` / `.classify(`。
这条规则比 code review 可靠。

### 3.3 崩溃与"进行中"的调用

| 情况 | 处理 |
| --- | --- |
| 调用前写 `running`，进程崩了 | 启动时把超过 N 分钟的 `running` 标 `interrupted`；pi 路径优先用 entry 补真实 usage |
| 服务商返回错误但已计费 | `status='error'`，usage 有就记，cost 有就记（这正是要"按实际"的原因） |
| 流式响应中途断开 | `message_update` 里有部分 usage；落 `aborted` + 部分 token，标记 `token_source='provider'` |
| 本地估算兜底 | `token_source='estimated'`，报表单独显示，不与精确值混在一起 |

### 3.4 一致性校验（不写测试就会腐化）

- 不变式：对每个 conversation，`SUM(ai_call.total_tokens)` == `harness.usage()` 的该会话合计。
  启动后跑一次、每日跑一次，差异写 `billing_drift` 并告警。
- 不变式：同一 `task_id` 下 `SUM(ai_call.charged_cost_usd)` == 该任务 settle 的金额。
- 冒烟：跑一个带工具的任务，断言 `ai_call` 行数 == assistant entry 数（+ 压缩次数）。

---

## 4. 价格从哪来

### 4.1 定价顺序

`billing.pricingMode` 三档，默认 `provider_first`：

| 模式 | 规则 |
| --- | --- |
| **`provider_first`（默认）** | 服务商上报了金额就用（`cost_source='provider'`）；没报就用设置页单价（`configured`）；再回退内置目录（`builtin`）；都没有 → `unpriced` |
| `configured_only` | 始终用设置页单价；服务商金额只写入 `provider_cost_usd` 供对账，不参与入账 |
| `provider_only` | 只认服务商金额；没报就是 `unpriced`（适合自带 key、要求与发票严格一致的审计场景） |

默认档同时启用 provider 与 configured，两者不是二选一，而是"有真账单时信账单，没有时信自己的价目表"。
`configured_only` 的价值是可预测、可审计：老板改一次价目表，所有新调用按新价走；
`provider_only` 的价值是与发票逐分对得上，代价是大量网关只给 token、最终满屏 `unpriced`。

`unpriced` **不写 0**。0 会被报表读成"免费"，必须是一个显式状态：
页面上显示「有 token，无价格」，并给出"去配置单价"的入口。
这和现在 `payroll.ts` 里"没有观测到单价就留空"的取舍一致，只是从推断升级为事实。

### 4.2 设置页的单价

现有 `model_provider.models` JSON 已经有 `inputUsdPerM / outputUsdPerM /
cacheReadUsdPerM / cacheWriteUsdPerM / tiers`，继续用它，不另建价格表。
为了让语音/图像也能算钱，补四个计价单位和一个单位标记：

| 字段 | 用于 | 计费量 |
| --- | --- | --- |
| `inputUsdPerM` / `outputUsdPerM` / `cache*UsdPerM` / `tiers` | chat / classifier / embedding | token |
| `perCharacterUsd` | **tts（默认单位）** | 输入文本字符数；OpenRouter 的 TTS 报价基本都是 `$ / M characters` |
| `perSecondUsd` | asr；少数按秒计价的 tts | `usage.seconds`（`speech.ts:137` 已拿到） |
| `perImageUsd` | image（按张计价的模型） | 输出张数 |
| `perMegapixelUsd` | image（FLUX.2 系列） | 输出像素数 / 1,000,000 |

再加一个 `billingUnit`：`token | character | second | image | megapixel`。

- 有 provider 的 `pricing` 元数据时，**单位由 provider 决定**（OpenRouter 的 endpoints API 会直接给出
  `{"unit":"image","cost_usd":0.04}` 或 `{"unit":"megapixel",...}`）；
- 没有时按能力取缺省：`tts → character`、`asr → second`、`image → image`；
- 单位不匹配就不算钱（记 `unpriced`），**不做跨单位换算猜测**（例如不能拿每张价乘一个假想张数）。

另外新增：

- `pricingMode`：**全局默认在「设置 → 通用 → 计费」**（见 §5.5），单个模型可在
  LLM / Image / Voice 页覆盖
- `cacheWrite1hUsdPerM`（Anthropic 的 1 小时缓存写入价）

同时补 UI 上缺的：

- 缓存读取/写入单价（现在大多数用户只填了 input/output，缓存 token 就被按 input 价算了）
- 阶梯价（pi 的 `tiers` 已支持，设置页还没暴露）
- "按当前单价试算 100 万 token" 的预览，避免小数点错位
- 语音的**每百万字符**、转写的**每秒**、图像的**每张 / 每百万像素**单价，
  空着就显示"未定价"，不默认 0

### 4.3 价格快照

`ai_call.price_snapshot` 存下单时用的费率（token 四费率 / 每百万字符 / 每秒 / 每张 / 每百万像素，或内置目录 id）。
之后老板改价格、换供应商，**历史账单不动**。这是审计要求，也避免"上个月的花费今天变了"。

### 4.4 provider 金额并不总是存在

多数 OpenAI 兼容网关只返回 token，不返回金额；OpenRouter 等少数会返回 `usage.cost`。
所以：

- `provider` 模式是"有就用"，不能当作默认前提；
- `configured` 模式保证**永远有数**，代价是老板必须维护单价；
- `provider_first` 是两者的组合，也是默认；
- 对账页展示「同一次调用：服务商 $0.0123 / 我们 $0.0131 / 差 +6.5%」，
  单价表过期时一眼能看出来。

### 4.5 内置默认单价（语音 / 图像）

数据来源：OpenRouter 模型页与 OpenRouter《Image Generation Models Compared》
（抓取于 **2026-11-02**；图像实测口径为 2026-09-11 的一次真实生成）。
这些只是**内置参考价**，在 `provider_first` 里排在第三位：

> provider `usage.cost` → 设置页单价 → 内置参考价 → `unpriced`

OpenRouter 自己说明价格变动频繁，"超过一个月的数字只能当规划值"。因此：

- 这些值只作为**新装缺省**写入内置目录，不覆盖老板已经填过的价；
- 每次调用仍把实际用的费率写进 `price_snapshot`，将来换表不影响旧账；
- provider 报了金额时以 provider 为准，内置价只用来做"漂移对比"。

#### TTS（按字符，`$/M characters` → `perCharacterUsd`）

| 模型 | OpenRouter 报价 | `perCharacterUsd` |
| --- | --- | --- |
| `elevenlabs/eleven-v4` | $80 / M chars | 0.00008 |
| `deepgram/flux-tts` | $45 / M chars | 0.000045 |
| `elevenlabs/eleven-flash-v2.5`（turbo） | $40 / M chars | 0.00004 |
| `deepgram/aura-2` | $30 / M chars | 0.00003 |
| `openai/tts-1-hd` | $30 / M chars | 0.00003 |
| `openai/tts-1` | $15 / M chars | 0.000015 |
| `qwen/qwen3-tts-flash` | $15 / M chars | 0.000015 |
| `qwen/qwen3-tts-plus` | $20 / M chars | 0.00002 |
| `assemblyai/assemblyai-tts-1` | $15 / M chars | 0.000015 |

`openai/gpt-4o-mini-tts` 是 **token 计价**（文本输入 + 音频输出），没有稳定的每字符价，
按 `$0.015/分钟` 估算只适合做规划，因此**不预置**，等 provider 的 `usage.cost`。

#### STT（按秒，`$/分钟` 先除以 60）

| 模型 | OpenRouter 报价 | `perSecondUsd` |
| --- | --- | --- |
| `openai/whisper-1` | $0.006 / 分钟 | 0.0001 |
| `elevenlabs/scribe-v2` | $0.000061 / 秒 | 0.000061 |
| `assemblyai/universal-3.6-pro` | from $0.000083 / 秒 | 0.000083 |
| `qwen/qwen3-asr-1.7b` | $0.000008 / 秒 | 0.000008 |
| `qwen/qwen3-asr-0.6b` | $0.000003 / 秒 | 0.000003 |

#### 图像（按张，`perImageUsd`）

| 模型 | OpenRouter 报价 / 实测 | `perImageUsd` |
| --- | --- | --- |
| `openai/gpt-image-2` | $0.006（短提示）～ $0.0135（长提示），按 token | 0.0135（按上限做规划，实际以 `usage.cost` 为准） |
| `bytedance-seed/seedream-4.5` | $0.04 / 张 | 0.04 |
| `black-forest-labs/flux-3-image` | from $0.041 / 张（随分辨率档位） | 0.041 |
| `recraft/recraft-v4.1-vector` | $0.08 / 张 | 0.08 |
| `sourceful/riverflow-v2.5-pro` | 标价 $0.13 / 张，实测 $0.064 | 0.13（按标价做上限） |
| `krea/krea-2-medium` | 实测 $0.03 / 张 | 0.03 |

#### 图像（按百万像素，`perMegapixelUsd`）

| 模型 | OpenRouter 报价 | `perMegapixelUsd` |
| --- | --- | --- |
| `black-forest-labs/flux.2-klein-4b` | 首个 MP $0.014，之后 $0.001 / MP | 0.014 |
| `black-forest-labs/flux.2-pro` | 首个 MP $0.03，之后 $0.015 / MP | 0.03 |
| `black-forest-labs/flux.2-flex` | 输入输出均 $0.06 / MP | 0.06 |
| `black-forest-labs/flux.2-max` | 首个 MP $0.07，之后 $0.03 / MP | 0.07 |

按 MP 计价的模型有**首 MP + 后续 MP** 的阶梯，P1 先按上表的首 MP 单价线性折算；
如果 provider 返回 `usage.cost`（OpenRouter 会返回），直接用真实值，不用这张表。

#### 不预置的模型

- 按 token 计费、且没有稳定每张价的图像模型（`gpt-5-image`、`gemini-*-image`）：
  不预置，等 provider 的 `usage.cost`；`gpt-image-2` 因为实测区间稳定，只给一个上限规划价；
- 按秒计价的 TTS（如 Seed Audio）：没有稳定的公开价，**留空 → `unpriced`**，
  由老板在设置页填；
- 完全匹配不上的模型：`unpriced`，**不猜**（沿用 `pricingMatch.ts` 现有的保守原则）。

---

## 5. 计费口径（已定）

### 5.1 谁付钱

一次调用可能同时算在：员工、部门、项目、公司。四个轴都是**完整金额**（不是四等分），
和现在的 `budget_ledger` 一致。报表只读一个轴。

### 5.2 失败的调用：算钱

**算。** 现在的 `workService.ts:228` 是"验收不通过就 `release`"，等于让失败的工作免费，
但 API 已经扣了钱。改成：

- **成本账**：所有真实发生的调用都记 `ai_call`，失败、超时、中断、重试都记；
- **预算账**：按真实花费扣，而不是"通过验收才扣"；
- `aborted` 只记服务商实际返回的那部分 usage；一点都没返回时才是 0；
- 报表里把失败工作的花费单列一行，让老板看到返工成本，而不是把它藏进"其他"。

### 5.3 对话、决策、语音、图像

**全部入账**，用 `operation` 区分：

| operation | 归属 | 用量口径 |
| --- | --- | --- |
| `chat` | 对话的 employee | token |
| `task` | 任务负责人 | token（含缓存/推理） |
| `summary` / `compaction` | 触发它的员工 | token |
| `decision` | 调用它的员工；系统调用则记公司 | token |
| `speech_stt` | 发起转写的员工 | 秒（少数新模型按 token，以 provider 的 `pricing` 为准） |
| `speech_tts` | 发起朗读的员工 | **字符**（多数 TTS 按 `$/M characters`；按秒计价的模型记秒） |
| `image` | 调用它的员工 | **张**；按 MP 计价的模型（FLUX.2）记百万像素 |
| `embedding` | 记忆所属员工 | token |
| `trial` | 无员工，记公司（招聘市场） | token |

不记这些的话，员工的成本只反映他跑任务的那部分，薪酬页会系统性偏低——
而这恰恰是"员工日常花的钱"里占比不小的部分。
语音/图像没有 token：`token_source='missing'`，金额走
`perCharacterUsd` / `perSecondUsd` / `perImageUsd` / `perMegapixelUsd`，
同时在 `ai_call` 记下 `billing_unit` 与 `billed_quantity`（字符数 / 秒数 / 张数 / 百万像素数），
这样明细页能显示"12,400 字符 × $0.000015 = $0.186"，而不是一个无法复核的金额。

字符数口径：provider 返回了字符/秒用量就用 provider 的；没有就本地算
（Unicode code point 数，不用 UTF-16 长度，避免中文/emoji 多算）。

### 5.4 币种

- 存储统一 **USD**（服务商账单几乎都是 USD）。
- 只展示 **USD / CNY** 两种；手工汇率在「设置 → 通用 → 计费」里填（见 §5.5），离线优先，不联网取价。
- **默认 `1 USD = 7.30 CNY`**，首次安装即生效，老板可改；不取实时汇率。
- 报表显示「按 7.30 折算」；汇率变化不回溯历史金额，历史行保留当时的 `fx_rate`。
- 不做多币种账本；`ai_call.currency` 留作字段，将来真要扩展再加。

### 5.5 汇率配置入口：目前确实没有

先把现状说清楚：**页面上没有任何汇率配置，代码里也没有货币层。**

| 位置 | 现状 |
| --- | --- |
| 全仓库搜 `汇率 / CNY / currency / fxRate` | 0 命中（`exchange` 只出现在 OAuth 与聊天语义里） |
| `apps/renderer/src/pages/budget/BudgetPage.tsx:38,131` | `money()` 硬编码 `$${value.toFixed(2)}` |
| `OrgPage.tsx:1771,2462` | 今日成本硬编码 `$` |
| `IssueListPage.tsx:387` | 图表 `valueFormat` 硬编码 `$` |
| `TaskCard.tsx:52` | 任务卡硬编码 `$` |
| `budget_ledger` / `PayrollLine.spentUsd` | 只有 USD，没有展示币种、没有汇率字段 |

所以这不是"开关藏在某个二级页"，而是设计里要**新增一页**。落点定在：

> **设置 → 通用 → 计费**（`/settings?page=billing`）

放在「通用」组，和外观、公司与称呼、压缩、运行时并列。理由：汇率是**全局展示口径**，
不是某个模型的属性；塞进 LLM 页会让人误以为只影响那一个模型。
定价策略也放这里（全局默认），模型级的覆盖仍留在 LLM / Image / Voice 页。

#### 页面内容

```
设置 → 通用 → 计费

定价策略
  ● provider 优先（默认）      有服务商金额就用，没有就用我填的单价
  ○ 只用我配置的单价            账单可预测，但需要维护价目表
  ○ 只认服务商金额              和发票逐分对得上，没有金额则显示"未定价"

展示币种
  [ CNY ▾ ]  USD / CNY

汇率
  1 USD = [ 7.30 ] CNY        [恢复默认]
  最后修改：2026-11-02 14:00

预览
  本月已花 $12.34 ≈ ¥90.08        ← 用真实汇总值实时试算
```

交互规则：

- 汇率只接受 `0 < 值 ≤ 100`、最多 4 位小数；非法值不写库，输入框就地报错。
- 切到 USD 时汇率输入仍保留可编辑（默认已填 7.3），避免来回切换要重填。
- 保存沿用现有设置页的「表单草稿 + 顶部保存」（和 `CompanyPage` 一致），不逐键写库。
- 预览用当前账本的真实总额试算，让老板一眼看出 7.3 和 7.2 的差别。
- 页面底部写明：**汇率只影响展示，账本永远以 USD 存储；改汇率不回溯历史。**

#### 需要新增的代码（按现有分层）

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 共享类型 | `packages/shared/src/domain.ts` | `PricingMode` / `DisplayCurrency` / `BillingSettings` |
| IPC 契约 | `packages/shared/src/ipc.ts` | `IPC.billing.get / update / changedEvent`、`BillingBridge` |
| 主进程存储 | `apps/main/src/work/billingSettings.ts` | 读写 `app_setting` 三个键，校验与默认值（照 `ocr/settings.ts` 的写法） |
| 主进程接线 | `apps/main/src/ipc/register.ts` | `handle` + 参数校验 + `broadcast(IPC.billing.changedEvent)` |
| 预加载 | `apps/main/src/preload.ts` | `billing: { get, update, onChanged }` |
| 渲染层状态 | `apps/renderer/src/entities/billing/model/useBilling.ts` | 读一次 + 订阅变更（照 `useCompany`） |
| 渲染层页面 | `apps/renderer/src/features/settings/ui/pages/BillingPage.tsx` | 上面那张表单 |
| 导航 | `SettingsShell.tsx` + 两个语言包 | 新增 `billing` 页签与文案 |

`app_setting` 键（沿用现有 `billing.*` 命名）：

```
billing.pricingMode      = 'provider_first'
billing.displayCurrency  = 'CNY'
billing.fxRateUsdCny     = 7.3
```

`ensureDefaults()` 在 bootstrap 时写入缺失的键。**升级不覆盖已有值**，
所以老用户第一次打开新版本时看到的就是 7.3，之后再改就是他的选择。

#### 展示层：一处格式化，全站复用

新增 `apps/renderer/src/shared/lib/money.ts`：

```ts
formatMoney(usd: number, settings: BillingSettings): string
// USD → $12.34
// CNY → ¥90.08（usd × usdCnyRate）
```

然后替换掉上面表格里的所有硬编码 `$`（预算页、组织页、工作项图表、任务卡）。
报表标题旁加一个可点的说明：`按 1 USD = 7.30 CNY 折算` → 点击跳到计费页。

明细页要区分两种汇率：

- **历史行**：按该行 `ai_call.fx_rate` 折算（入账当天冻结的值）；
- **汇总/预测**：按设置页当前汇率折算，并标注"按当前汇率"。

两者不一致是正常的（老板改过汇率），不能用一个数字糊过去。

#### 默认值

- `billing.pricingMode` = `provider_first`
- `billing.usdCnyRate` = `7.3`
- `billing.displayCurrency` = `CNY`

选 `CNY` 是因为界面本来就是中文、老板看的是人民币；代价是升级后预算页的 `$` 会变成 `¥`。
如果希望升级时观感完全不变，把默认改成 `USD` 即可——只是一个常量，不影响账本。

---

## 6. 报表怎么变

| 报表 | 现在 | 之后 |
| --- | --- | --- |
| 薪酬 `payroll.ts` | `budget_ledger` 求和 + `cost/tokens` 反推单价 | `SUM(ai_call.charged_cost_usd)`，单价来自快照；新增"未定价 token"列 |
| 成本中心 `budgetCenter.ts` | 同上 | 同上，另加按模型的拆分 |
| 预算页 | token 上限 + 预计 | 不变；新增"本月已花 / 按当前速度月底花"两个金额 |
| 新增：调用明细 | 无 | 按员工/部门/项目/模型/operation/时间筛选，能看到每一次调用的 token、单价、金额、耗时、状态 |
| 新增：定价漂移 | 无 | `provider` vs `configured` 的差额排行，指导改单价 |

`budget_ledger` 的 `cost_usd` 保留，作为"预算轴口径"的物化值；`ai_call` 是明细来源。
两者的一致性由 3.4 的不变式保证。

---

## 7. 迁移

`V25`（追加式，不重写历史）：

1. 建 `ai_call` / `ai_call_charge`。
2. 老数据回填：每条 `budget_ledger(kind='settle', scope='employee')` 生成一行
   `ai_call(operation='legacy', token_source='estimated', cost_source='legacy')`，
   `idempotency_key = 'legacy:' || ledger.id`。
   这样"本月花费"在升级前后连续，不会某天突然从 0 开始。
3. `legacy` 行不参与"调用明细"的模型维度统计（没有模型信息），但计入总额。

新增设置（`app_setting`，页面落点见 §5.5）：

- `billing.pricingMode` = `provider_first`
- `billing.displayCurrency` = `CNY`（USD / CNY）
- `billing.fxRateUsdCny` = **7.3**
- 语音/图像模型的 `perCharacterUsd` / `perSecondUsd` / `perImageUsd` / `perMegapixelUsd`
  与 token 单价存在同一份 `models` JSON 里；缺省值见 §4.5

历史回填的规则（已定）：

- 每条 `budget_ledger(kind='settle', scope='employee')` 生成一行 `ai_call`；
- `idempotency_key = 'legacy:' || ledger.id`，重复执行不会产生第二行；
- `operation='legacy'`、`token_source='estimated'`、`cost_source='legacy'`，`id='legacy-' || ledger.id`；
- 计入月度总额与员工/部门/项目轴，但不参与"按模型"的统计（没有模型信息）；
- `ai_call_charge` 也按当时的四条轴补齐，保证切换报表后历史数字不变。

---

## 8. 分期落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | `ai_call` 表 + pi entry 投影 + 启动补账 + `legacy` 回填 + 任务级报表切换 | 跑任务后行数对得上；杀进程重启后不丢账；升级前后月度总额一致 |
| P1 | 价格快照、`cost_source`、`unpriced`、失败/中断调用计费、语音/图像按字符/秒/张/百万像素 + 内置参考价 | 改单价不影响历史；失败调用出现在账上；无价模型显示"未定价"而不是 $0 |
| P2 | MeteredRuntime 覆盖 chat / summary / decision / speech / image / embedding / trial | 静态检查通过；每个入口都有 `ai_call` |
| P3 | 调用明细页、定价漂移页、**设置 → 通用 → 计费**（汇率 / 展示币种 / 定价策略） | 能从总额下钻到单次调用；预算页可切 ¥ 并显示折算汇率 |
| P4 | 每日对账任务 + 差异告警 | 连续 30 天 drift = 0 |

P0 单独就有价值：它把"钱到底花在哪"从任务级降到调用级，而且不改任何业务流程。

---

## 9. 明确不做

- 不做实时汇率/联网取价：汇率手工配置（默认 7.3）；语音/图像参考价随安装包内置，
  带抓取日期，不在运行时联网更新。
- 不做多币种账本：先 USD。
- 不做"预算按金额硬停"：现有 token 硬停继续用；金额只做展示与预测
  （token 限制对模型无关，金额限制会因换模型而失真）。
- 不重写 `budget` 表：它是上限与硬停状态，职责不变。

---

## 10. 已定口径与仍需确认的细节

已定（见 §0.1）：

1. 失败 / 中断 / 报错的调用计费。
2. 对话、决策、语音、图像全部进员工成本。
3. 默认定价 `provider_first`（provider 优先，configured 兜底），保留 `configured_only` / `provider_only`。
4. USD / CNY 双币展示，手工汇率。
5. 历史回填为 `legacy` 调用。
6. 汇率默认 **7.30**。
7. 语音/图像内置参考单价（§4.5），provider 有金额时以 provider 为准。
8. 汇率/币种/定价策略的配置页落在 **设置 → 通用 → 计费**（§5.5），展示币种默认 CNY。

仍需确认的细节（不影响 P0 开工）：

- **失败任务的预算扣减时机**：调用发生时就扣（更真实），还是任务结束时统一结算（更少抖动）。
  建议前者，P0 可以先沿用任务结束结算，P1 再改。
- **内置参考价的更新方式**：目前是"随版本内置 + 标注抓取日期"。
  如果希望老板能在设置页一键拉取最新价，那就要开一个联网取价入口，
  与 §9"不做运行时联网取价"冲突，需要单独决定。
