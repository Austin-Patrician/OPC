/**
 * Domain contracts shared by the Electron main process and the renderer.
 * Pure types only — no runtime imports, no IO, no framework.
 */

export type AgentStatus = 'working' | 'online' | 'idle' | 'paused';

/** An employed agent. Mirrors the daemon's `employee` projection. */
export interface Agent {
  id: string;
  name: string;
  role: string;
  level: string;
  departmentId: string;
  avatarUrl?: string;
  model: string;
  status: AgentStatus;
  skills: string[];
  /** Per-employee working notes; rendered in the dossier drawer. */
  briefMd: string;
}

export type ConversationKind = 'dm' | 'group' | 'channel';

/**
 * §7.5 lifecycle. `cooling` is an idle thread that must not generate new replies;
 * `escalated` is one that never converged and now needs you (§7.3 turn limit).
 * Archiving is tracked separately (`archivedAt`) because the sweep queries it.
 */
export type ConversationStatus = 'open' | 'cooling' | 'escalated';

export interface Conversation {
  id: string;
  title: string;
  kind: ConversationKind;
  avatarUrl?: string;
  lastMessage: string;
  /** Optional prefix rendered in the danger color (e.g. `[@everyone]`). */
  lastMessageHighlight?: string;
  timestamp: string;
  unreadCount?: number;
  muted?: boolean;
  departmentId?: string;
  memberIds: string[];
  /** Set once the conversation is archived and its lessons consolidated. */
  archivedAt?: number;
  primaryAgentId?: string;
  /** Employee-authored turns; the your own messages never count (§7.3 ②). */
  turnCount?: number;
  /** Defaults to `open` when absent (payloads written before Step 3). */
  status?: ConversationStatus;
  statusChangedAt?: number;
  messages: Message[];
}

export interface DeliverableMeta {
  workId: string;
  accountName: string;
  status: string;
  campaigns: string;
  link: string;
  specsTitle: string;
  specs: string[];
  pitfallsTitle: string;
  pitfalls: string[];
}

export interface Deliverable {
  intro: string;
  title: string;
  meta: DeliverableMeta;
}

export type MessageKind = 'text' | 'deliverable' | 'system' | 'task';

/** ── Work / task pipeline (Phase 0) ─────────────────────────────────────── */

export type IssuePriority = 'P0' | 'P1' | 'P2' | 'P3';

export type LinkType = 'blocks' | 'duplicates' | 'relates';

export interface IssueLink {
  taskId: string;
  issueKey?: string;
  title: string;
  status: TaskStatus;
}

export type TaskStatus =
  | 'open'
  | 'running'
  | 'review'
  | 'accepted'
  | 'delivered'
  | 'rejected'
  | 'failed'
  /** Cancelled by the system, e.g. the assignee was terminated (F10). */
  | 'cancelled';

export interface TaskArtifact {
  id: string;
  /** Path relative to the task workspace. */
  relPath: string;
  bytes: number;
  sha256: string;
}

export interface TaskEvidence {
  /** argv form — never a shell string. */
  command: string[];
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

export interface TaskAcceptance {
  verdict: 'pass' | 'fail';
  reason: string;
  evidence: TaskEvidence;
  createdAt: number;
}

export interface TaskStep {
  at: number;
  text: string;
}

/**
 * 你在活还没干完时改的一句话。
 *
 * 单独一个类型而不是裸 `string[]`：它以后大概会长出「谁说的」「针对哪一版交付」，
 * 而那时库里已经存着旧数据了——加字段比重解释一个字符串便宜。
 */
export interface TaskSteering {
  note: string;
  at: number;
}

/**
 * 执行体看到的一条**原始记录**（§3.3）。
 *
 * 在这之前执行体只看到 Router 写的一句话（`brief`）——原始事件、这条线之前的汇报、
 * 之前跑过的任务，它一概看不到。后果不是"信息少"，是**不可自纠**：Router 把 A 理解成
 * B 时，执行体是唯一有机会发现的人，而它手里没有 A。
 *
 * 这里给的是 **ID + 摘要**，不是全文。全文留在库里，要用就 `recall <id>`——和 Router
 * 那一侧用的是同一个 spill 函数，所以两层看到的是同一段文字。
 */
export interface TaskRecord {
  kind: 'event' | 'report' | 'task';
  /** `recall <id>` 用的就是它。 */
  id: string;
  title: string;
  /** 已 spill 过的正文：头尾 + 略去了多少 + 全文怎么取。 */
  excerpt: string;
}

export interface WorkTask {
  id: string;
  title: string;
  brief: string;
  /** What must exist when the task is done, in plain language. */
  deliverableSpec: string;
  assigneeId: string;
  assigneeName: string;
  parentTaskId?: string;
  /** The project this work is charged to (§8.1); absent = no project axis. */
  projectGroupId?: string;
  /**
   * The v2 line of work this task belongs to. Absent for tasks created before
   * threads existed, and for work that never belonged to a goal.
   */
  threadId?: string;
  /**
   * The execution body that ran this task. Its id is the harness key, so two
   * workers on one thread never share a runtime. Absent on legacy tasks.
   */
  workerId?: string;
  /** Human handle, e.g. `ENG-12`; derived from the assignee's department code. */
  issueKey?: string;
  /** P0 (do it now) … P3 (someday). Defaults to P2. */
  priority: IssuePriority;
  labels: string[];
  dueAt?: number;
  /** Unfinished blockers: the task is not allowed to start until they are done. */
  blockedBy: IssueLink[];
  /** Set when a task is the manager sign-off of another task. */
  reviewOfTaskId?: string;
  /** Review tasks are judged by you, never by another manager review. */
  isReview: boolean;
  /** 0 for tasks you dispatched directly. */
  depth: number;
  /** How many subtasks this task decomposed into (0 for leaves). */
  childCount: number;
  estTokens: number;
  /** System-owned checker, run in the task workspace. */
  acceptanceCommand: string[];
  /** The assignee's charter, when it has one. */
  /** The job's responsibilities, read live from `position → job` at task load. */
  /** Memories recalled for this run (L2 personal experience, L5 episodic). */
  memories?: { kind: string; content: string; scopeType: string }[];
  /** Current company/department facts (fact), most specific last. */
  facts?: { statement: string; scopeType: string }[];
  /**
   * 这件事的原始记录（事件 / 汇报 / 之前跑过的任务），带 ID 与摘要。
   *
   * 有了它，执行体才能"顺着引用图往回走"，而不是只能相信 Router 的转述。
   */
  records?: TaskRecord[];
  /**
   * 常驻约束：用户要求过、一直有效的那几条。
   *
   * 和 `memories` 分开：那些是"按相关度想起来的相关经验"，可能这次一条都不相关；
   * 这一组是**每一轮原样在场**的，不参与检索、不看相关度。
   */
  standing?: { content: string }[];
  /**
   * 做事规矩：用户要求过的格式与流程（`format` / `workflow`）。
   *
   * 和 `memories` 分开：那些是"按相关度想起来的相关经验"，是建议；这一组是**对输出的
   * 约束**，不参与相关度筛选，必须遵守。
   */
  procedural?: { kind: string; content: string }[];
  /**
   * 你中途改的方向。
   *
   * 和 `brief` 分开存，因为它们是两种东西：`brief` 是派活时说的话，`steering` 是
   * 你后来改主意说的话，**后者优先**。每次尝试都会重新从库里读任务，所以写在
   * 这里的话下一轮一定带得上——这是 §8.2「随时介入」在双层架构里的落点。
   */
  steering?: TaskSteering[];
  /** Which system checker to run: an HTTP service or "an image is served with 200". */
  acceptanceTemplate: AcceptanceTemplate;
  status: TaskStatus;
  workspaceRelPath: string;
  createdAt: number;
  /** Last write to the row; used to detect abandoned running tasks. */
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  artifacts: TaskArtifact[];
  acceptance?: TaskAcceptance;
  /** How many times the system checked this task (1 = no repair needed). */
  attempts: number;
  /** Real token spend accumulated across attempts (charged on settle). */
  tokensUsed: number;
  /** Real spend in USD, from the model's price and pi's usage accounting. */
  costUsd: number;
  error?: string;
  steps: TaskStep[];
}

/** ── 你是谁：工作台资料与称呼 ─────────────────────────────────────────── */

/**
 * 一个执行体不许调用的工具。
 *
 * 用**黑名单**而不是白名单：空策略的意思是"当前运行时能装的都给它"，所以新扩展会
 * 自动出现在已有执行体身上，而不是因为有人拨过一次开关就被静默关掉。
 */
export interface ToolPolicy {
  /** Extension names (e.g. `opc.image`) this executor must not get. */
  disabledExtensions: string[];
  /** Tool names (e.g. `bash`) this executor must not get, even when installed. */
  disabledTools: string[];
}

/**
 * 这台机器上的那个工作台：`company` 那一行，加上没有自己列的那点资料
 * （你在做什么、一句话目标、配色、怎么称呼你）。读写都走 `window.opc.company`，
 * 所以渲染层不会在 localStorage 里存第二份。
 */
export interface CompanyProfile {
  id: string;
  /** Displayed in the title bar and on the onboarding card. */
  name: string;
  /** `content` | `ecommerce` | … — 渲染层拥有这份词汇表。 */
  domain: string;
  goal: string;
  /** Brand palette id; unknown ids fall back to the default palette entry. */
  colorId: string;
  /** What you are called in the UI ("我" by default). */
  userName: string;
  /** Uploaded logo as a base64 data URL; absent = monogram. */
  logo?: string;
  /** Uploaded avatar as a base64 data URL; absent = initials. */
  userAvatar?: string;
}

/** Partial update; omitted fields keep their stored value. */
export interface CompanyProfilePatch {
  name?: string;
  domain?: string;
  goal?: string;
  colorId?: string;
  userName?: string;
  /** Data URL; `''` removes the uploaded image. */
  logo?: string;
  userAvatar?: string;
}

/** ── Runtime environments (global base environment) ────────────────────── */

/** Languages the app knows how to launch. */
export type RuntimeKind = 'node' | 'python';

/**
 * One selectable interpreter. The environment is company-wide: every employee
 * shares it, so there is deliberately no per-employee or per-task override.
 */
export interface RuntimeProfile {
  id: string;
  name: string;
  kind: RuntimeKind;
  /** Absolute interpreter path; '' for a built-in that is detected at use time. */
  binary: string;
  /** Directories prepended to PATH (venv/bin, nvm/.../bin, conda env bin). */
  binDirs: string[];
  /** Variables overlaid on the child process. */
  env: Record<string, string>;
  /** Built-ins come from code and cannot be deleted. */
  isCustom: boolean;
  createdAt: number;
}

/** Which profile is in force for each language. `null` = auto-pick. */
export interface RuntimeState {
  profiles: RuntimeProfile[];
  active: Record<RuntimeKind, string | null>;
}

/** Availability of one profile, refreshed by a probe. */
export interface RuntimeStatus {
  profileId: string;
  available: boolean;
  /** Resolved absolute binary, when it exists. */
  binary?: string;
  version?: string;
  /** Why it is unavailable, or a non-fatal note. */
  detail?: string;
}

export interface RuntimeSnapshot extends RuntimeState {
  statuses: RuntimeStatus[];
}

/** The only fields the settings page may submit for a new custom profile. */
export interface RuntimeProfileDraft {
  name: string;
  kind: RuntimeKind;
  binary: string;
}

/** Result of inspecting an interpreter before saving it. */
export interface RuntimeInspection {
  ok: boolean;
  binary: string;
  version?: string;
  detail?: string;
  /** Derived by looking at the interpreter's layout (venv / conda). */
  binDirs: string[];
  env: Record<string, string>;
}

/**
 * An engine whose models ship *with* the app — you cannot pick another one,
 * so it is never a profile. It still belongs on the runtime page: "can this
 * machine read a picture" is machine state, exactly like a missing interpreter.
 *
 * Deliberately thin: the page answers "on or off", and the file inventory is a
 * build-time concern that belongs in the error message, not in the UI.
 */
export interface BundledRuntime {
  id: string;
  name: string;
  /** What actually runs it, e.g. `onnxruntime-web · WASM/WebGPU`. */
  engine: string;
  version: string;
  /**
   * `incomplete` = a file is missing or truncated (reinstall fixes it);
   * `corrupt` = right size, wrong bytes (only a hash can see that).
   */
  state: 'ok' | 'incomplete' | 'corrupt';
  /** How many of the expected files failed; nothing when `state` is `ok`. */
  broken: number;
}

/** ── Model providers (slice A) ─────────────────────────────────────────── */

export type ModelCapability = 'chat' | 'image' | 'classifier' | 'asr' | 'tts' | 'video';

/** One selectable model, flattened for the UI. */
export interface ModelOption {
  id: string;
  name: string;
  capability: Exclude<ModelCapability, 'video'>;
  /** Context window in tokens; compaction thresholds are derived from it. */
  contextWindow?: number;
  /** API kind of this model (`openai-completions`, `anthropic-messages`, ...). */
  api?: string;
  /** Whether the model accepts image input. Absent = unknown. */
  vision?: boolean;
  /** Whether the model supports reasoning/thinking. Absent = unknown. */
  reasoning?: boolean;
  /** USD per 1M tokens. Mirrors pi's ModelCost, cache included. */
  inputUsdPerM?: number;
  outputUsdPerM?: number;
  cacheReadUsdPerM?: number;
  cacheWriteUsdPerM?: number;
  /** Context-bucket pricing: rates above `inputTokensAbove` input tokens. */
  tiers?: PriceTier[];
  /**
   * Switched on for image generation (Settings → Image).
   *
   * An image-capable row can sit in the list for other reasons — the LLM page
   * materialises a provider's whole catalog, image models included — so "the row
   * exists" must never be read as "this model is enabled for images".
   */
  imageEnabled?: boolean;
  /**
   * Switched on for speech (Settings → Voice). Separate from `capability`
   * because the LLM page materialises a provider's whole catalog, voice models
   * included; a stored row alone must not make the mic or read-aloud resolve
   * to it.
   */
  voiceEnabled?: boolean;
  /**
   * Switched on for chat (Settings → LLM). Absent means enabled: every row
   * stored before this switch existed keeps working, so the flag is opt-out.
   * A disabled model is not registered with the runtime, which is how a
   * provider with 600 catalog models stays usable.
   */
  chatEnabled?: boolean;
  /**
   * Switched on for decisions (Settings → Decision).
   *
   * Classifier rows are a different operation, not a chat variant: Jev answers
   * typed questions about a `state` and never produces text. The LLM page may
   * have stored such an id as a chat row before this switch existed, so only the
   * explicit flag makes it resolvable by `decisions.classify`.
   */
  decisionEnabled?: boolean;
}

/** A chat row is usable unless it was explicitly switched off. */
export function isChatModelEnabled(model: { chatEnabled?: boolean }): boolean {
  return model.chatEnabled !== false;
}

/**
 * Whether the LLM page should list this provider.
 *
 * The LLM page is the chat page. Two kinds of rows do not belong there:
 *
 * - relays created on the Decision page (`scope: 'decision'`), whose models are
 *   classifiers;
 * - rows written before `scope` existed that only own classifier models.
 *
 * A provider that mixes chat and classifier models (OpenRouter) stays visible:
 * one row legitimately serves both pages.
 */
export function isLlmProvider(provider: {
  scope?: ProviderScope;
  models?: readonly { capability?: string }[];
}): boolean {
  if (provider.scope === 'decision') return false;
  const models = provider.models ?? [];
  // Empty means "just created, no models yet" — that row is still being set up,
  // so it stays where it was created instead of vanishing from both pages.
  return !(models.length > 0 && models.every((model) => model.capability === 'classifier'));
}

export interface CatalogModel {
  id: string;
  name: string;
  type: 'chat' | 'image' | 'classifier' | 'asr' | 'tts';
  api: string;
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
  price?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: {
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }[];
  };
}

export interface CatalogProvider {
  id: string;
  baseUrl: string;
  apis: string[];
  counts: { chat: number; image: number; classifier: number; asr: number; tts: number };
  models: CatalogModel[];
}

export interface PriceTier {
  inputTokensAbove: number;
  inputUsdPerM: number;
  outputUsdPerM: number;
  cacheReadUsdPerM: number;
  cacheWriteUsdPerM: number;
}

/** Mirror of pi's compaction policy, edited in Settings → 工作区与压缩. */
export interface CompactionSettings {
  enabled: boolean;
  /** Free space kept for the answer; compaction starts above `contextWindow - reserve`. */
  reserveTokens: number;
  /** Recent context kept verbatim. */
  keepRecentTokens: number;
  /** Start a background compaction this far below the blocking threshold; 0 disables. */
  backgroundTokens: number;
}

/**
 * Which settings page owns a provider row.
 *
 * A custom relay created on the Decision page serves classifiers only, so the
 * LLM page must not offer it as a chat provider. Built-in providers are always
 * `llm`: they ship with the app and one row may serve chat and decisions at once
 * (OpenRouter is both). The field only decides *visibility*, never capability.
 */
export type ProviderScope = 'llm' | 'decision';

export interface ProviderConfig {
  id: string;
  name: string;
  /** Empty for providers whose SDK default applies. */
  baseUrl: string;
  /** pi api kind, e.g. `openai-completions` / `anthropic-messages`. */
  api: string;
  isCustom: boolean;
  /** Owner page; `undefined` means `llm`. */
  scope?: ProviderScope;
  /**
   * Provider id whose icon this one reuses (custom providers only). Empty or
   * undefined falls back to initials.
   */
  icon?: string;
  /** Never carries the secret: the renderer only learns whether a key exists. */
  hasKey: boolean;
  models: ModelOption[];
  updatedAt: number;
}

/** Which model plays which role. `null` = not configured. */
export interface ModelDefaults {
  /** Writes deliverables for tasks. */
  llm: ModelRef | null;
  image: ModelRef | null;
  /** Speech recognition (microphone input). */
  asr: ModelRef | null;
  /** Speech synthesis (read aloud). */
  tts: ModelRef | null;
  /** Structured decisions (Jev / System One classifiers). */
  decision: ModelRef | null;
}

/** ── Decision (System One / classifier) ────────────────────────────────── */

/**
 * One typed question sent to a decision model.
 *
 * `bool` is the public name for TypeSafe's `noul` wire type; the pi adapter
 * translates between them, so the app never has to know the vendor vocabulary.
 */
export type DecisionQuestion =
  | {
      type: 'choice';
      /** What the model should decide. Required by every System One service. */
      instructions: string;
      /** Choice name → what it means. Jev requires at least one. */
      criteria: Record<string, string>;
    }
  | {
      type: 'score';
      instructions: string;
      /** Ordered rubric; index is the score (0-based). */
      criteria: string[];
    }
  | {
      type: 'bool';
      instructions: string;
      /** What true / false mean. pi's classifier contract requires both. */
      criteria: { true: string; false: string };
    };

export type DecisionAnswer =
  | {
      type: 'choice';
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: 'score';
      score: number;
      confidence: number;
      legend?: Record<string, string>;
      probabilities?: Record<string, number>;
    }
  | { type: 'bool'; probability: number };

export interface DecisionClassifyInput {
  /** Free text sent as the request's `state`, wrapped as `{ text }`. */
  state: string;
  questions: Record<string, DecisionQuestion>;
  /** Explicit model; omitted means the configured default decision model. */
  modelId?: string;
}

export interface DecisionClassifyResult {
  ok: boolean;
  /** The configured model id that answered (`jev-latest`); aliases resolve upstream. */
  model?: string;
  answers?: Record<string, DecisionAnswer>;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
}

/** ── Speech (ASR / TTS) ────────────────────────────────────────────────── */

export type SpeechLanguage = 'auto' | 'zh' | 'en';

export interface SpeechTranscribeInput {
  /** Raw audio bytes, never a data URL: the renderer records and sends WAV. */
  audio: Uint8Array;
  mimeType: string;
  language?: SpeechLanguage;
  /** Explicit model; omitted means the configured default ASR model. */
  modelId?: string;
}

export interface SpeechTranscribeResult {
  ok: boolean;
  text?: string;
  model?: string;
  /** Audio duration reported by the provider, when it does. */
  seconds?: number;
  error?: string;
}

export interface SpeechSynthesizeInput {
  text: string;
  /** Built-in voice id (Xiaomi) or an OpenAI voice name. */
  voice?: string;
  format?: 'wav' | 'mp3';
  /** Explicit model; omitted means the configured default TTS model. */
  modelId?: string;
}

export interface SpeechSynthesizeResult {
  ok: boolean;
  bytes?: Uint8Array;
  mimeType?: string;
  model?: string;
  error?: string;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  isCustom: boolean;
  /** `undefined` leaves the stored owner page untouched. */
  scope?: ProviderScope;
  /** Provider id whose icon to reuse; `''` clears it, `undefined` leaves it unchanged. */
  icon?: string;
  /** Optional plaintext key; encrypted in the main process and never echoed back. */
  apiKey?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  models?: ModelOption[];
  durationMs?: number;
}

/** ── Budget (Phase 0, slice B) ─────────────────────────────────────────── */

/**
 * The four axes a run can be charged on (§8.1). `project` and `department` exist
 * because a project is where money is actually decided; `company` is the backstop.
 */
export type BudgetScope = 'company' | 'employee' | 'project' | 'department';
export type BudgetState = 'ok' | 'warn' | 'stopped';


export interface Budget {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  /** `YYYY-MM` for monthly budgets. */
  periodKey: string;
  limitTokens: number;
  usedTokens: number;
  reservedTokens: number;
  /** limit - used - reserved, never negative. */
  availableTokens: number;
  warnAt: number;
  hardStopAt: number;
  isStopped: boolean;
  state: BudgetState;
  updatedAt: number;
}

export type BudgetErrorCode =
  | 'BUDGET_STOPPED'
  | 'BUDGET_EXCEEDED'
  | 'BUDGET_MISSING'
  /** The assignee is unknown or no longer employed. */
  | 'ASSIGNEE_UNAVAILABLE'
  /** Decomposition refusals (depth / fan-out / budget / hierarchy). */
  | 'DECOMPOSE_EMPTY'
  | 'DECOMPOSE_DEPTH'
  | 'DECOMPOSE_FANOUT'
  | 'DECOMPOSE_BUDGET'
  | 'DECOMPOSE_NOT_ASSIGNABLE'
  | 'DECOMPOSE_SELF';

/** Structured refusal: the UI shows this verbatim instead of a generic error. */
export interface BudgetError {
  code: BudgetErrorCode;
  message: string;
  budget?: Budget;
  requestedTokens?: number;
}

/** Task-level refusal (budget, employment, decomposition). */
export type TaskError = BudgetError;

/**
 * How a call's money is decided (doc: `docs/ai-billing.md` §4.1).
 *
 * `provider_first` is the default: trust a provider-reported amount when there is
 * one, otherwise fall back to the price list you maintains. The two strict
 * modes exist for audit (`configured_only`) and invoice-parity (`provider_only`)
 * installs.
 */
export type PricingMode = 'provider_first' | 'configured_only' | 'provider_only';

/** Only USD is stored; CNY is a display conversion at a manual rate. */
export type DisplayCurrency = 'USD' | 'CNY';

/** Settings → 通用 → 计费. One row per install, stored in `app_setting`. */
export interface BillingSettings {
  pricingMode: PricingMode;
  displayCurrency: DisplayCurrency;
  /** 1 USD = N CNY. Display-only; the ledger never converts. */
  usdCnyRate: number;
  /** Last write to any of the three keys, for "最后修改" in the UI. */
  updatedAt: number;
}

/** `usdCnyRate` is a manual planning rate, not a live quote. */
export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  pricingMode: 'provider_first',
  displayCurrency: 'CNY',
  usdCnyRate: 7.3,
  updatedAt: 0,
};

export interface BillingSettingsPatch {
  pricingMode?: PricingMode;
  displayCurrency?: DisplayCurrency;
  usdCnyRate?: number;
}

export type CreateTaskResult =
  | { ok: true; task: WorkTask }
  | { ok: false; error: BudgetError };

export type AcceptanceTemplate =
  | 'http-ok'
  /** 交付物自带的 node:test 套件必须跑通（普通软件工作的默认闸门）。 */
  | 'node-test'
  | 'image-200'
  | 'review-verdict';

/** One subtask a manager wants to create. */
export interface SubtaskDraft {
  title: string;
  brief: string;
  deliverableSpec: string;
  assigneeId: string;
  estTokens: number;
  acceptanceTemplate?: AcceptanceTemplate;
}

export interface CreateTaskInput {
  title: string;
  brief: string;
  deliverableSpec: string;
  assigneeId: string;
  /** Charges this project's budget as well; subtasks inherit it (§8.1). */
  projectGroupId?: string;
  /**
   * The line of work this task belongs to (v2 core). Subtasks inherit their
   * parent's thread, so one goal's worth of tasks can be recalled together.
   */
  threadId?: string;
  /**
   * Which execution body runs it. Set by the dispatcher when it has already
   * chosen a worker; omitted means "work it out from the assignee".
   */
  workerId?: string;
  estTokens: number;
  acceptanceCommand: string[];
  acceptanceTemplate: AcceptanceTemplate;
  /** Service-internal: mandatory system steps (manager sign-off) may overdraw. */
  allowOverdraft?: boolean;
}

/** ── 网络与代理 ──────────────────────────────────────────────────────────── */

/**
 * `system` follows the OS proxy, `direct` ignores every proxy, `manual` uses the
 * server below. The default is `system`, which is what an ordinary install does
 * today — the feature is opt-in but never silently re-routes traffic.
 */
export type ProxyMode = 'system' | 'direct' | 'manual';

/** `https` means "the proxy itself speaks TLS", not "proxy HTTPS traffic". */
export type ProxyProtocol = 'http' | 'https' | 'socks5';

/**
 * The stored config as the renderer sees it.
 *
 * `password` is deliberately absent: the secret is encrypted with the OS keychain
 * in `app_setting` and never crosses IPC. The UI only learns whether one exists.
 */
export interface ProxyConfig {
  mode: ProxyMode;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  /** A password is stored for this proxy; the value itself is never returned. */
  hasPassword: boolean;
  /** Comma-separated hosts that skip the proxy; loopback is always added. */
  bypass: string;
}

/**
 * Write shape. `password: undefined` keeps the stored secret, `''` clears it and
 * any other value replaces it — the same three-state contract as `setKey`.
 */
export interface ProxyConfigInput {
  mode: ProxyMode;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password?: string;
  bypass: string;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  /** Egress IP observed by the probe endpoint, when it answered. */
  ip?: string;
}

export interface Message {
  id: string;
  kind: MessageKind;
  /** Agent id, `'user'` for you, `'system'` for HR/system notices. */
  senderId: string;
  senderName: string;
  senderRole?: string;
  senderAvatarUrl?: string;
  /** Wall-clock label, already formatted (`14:05`). */
  timestamp: string;
  /** Optional centered divider shown above the message. */
  timeHeader?: string;
  text?: string;
  deliverable?: Deliverable;
  /** Task card payload when `kind === 'task'`. */
  task?: WorkTask;
  mentions?: string[];
}

/**
 * ── v2 core: thread / worker / trigger / report ─────────────────────────────
 *
 * The centre of the model moved from `employee` to `thread`
 * (docs/v2/00-audit.md §2): what you follows is a line of work, not a
 * person. A `worker` is an execution body that exists for as long as a thread
 * needs it — it has a template and skills, and no career, no rank, no reporting
 * line, and no memory you is not allowed to read.
 */

export type ThreadState = 'open' | 'running' | 'waiting' | 'done' | 'failed' | 'archived';

/**
 * How loudly a thread is allowed to reach you.
 *
 * `silent` is the default and the point of the whole design: work that needs no
 * decision finishes without a notification. `decide` is the only level allowed
 * to interrupt, and every use of it spends the thread's attention quota.
 */
export type AttentionLevel = 'decide' | 'notify' | 'silent';

/** One line of work: goal in, deliverable + verdict out. */
export interface WorkThread {
  id: string;
  title: string;
  goal: string;
  /**
   * 这条线在**环境里**的身份：`folder:inbox/report.md`、`im:dm-router`、
   * `github:o/r#12`。
   *
   * 它是直通（§3.2）的唯一依据。同一个话题的后续事件带着同一个 key 到达，
   * 程序查一次表就知道该不该绕过 Router 直接发给订阅它的 worker——不需要模型判断，
   * 也不会因为模型换了措辞就分成两条线。
   */
  threadKey: string | null;
  /** 这条线是哪个来源的影子。与 `threadKey` 的前缀一致，单独存一份为了能按来源筛。 */
  source: TriggerSource;
  /** 外面那个 id：`acme/api#12`、`oc_xxx:om_yyy`。没有身份的老线是 null。 */
  externalId: string | null;
  state: ThreadState;
  attention: AttentionLevel;
  /**
   * 静默线（§3.4）。
   *
   * Router 判断"这件事值得跑，但值不值得让他知道还不确定"时开这种线。规矩是反的：
   * **汇报永远不是 `decide`**——跑通了才 `notify`，没跑通就 `silent` 归档。
   * `decide` 的意思是「我要你放下手上的事」，而投机的前提恰恰是它还没有确定性价值。
   */
  speculative: boolean;
  /** Hard token ceiling for the whole thread; null = only the global cap applies. */
  budgetTokens: number | null;
  spentTokens: number;
  createdAt: number;
  lastActivityAt: number;
  closedAt: number | null;
}

/** What kind of work a worker is instantiated for. Not a job title. */
export type WorkerTemplate = 'research' | 'code' | 'ops';

export type WorkerStatus = 'idle' | 'running' | 'retired';

export interface Worker {
  id: string;
  name: string;
  template: WorkerTemplate;
  skills: string[];
  /** Null between threads: a spent worker is retired, not remade. */
  threadId: string | null;
  /**
   * Who fills this execution body. During the migration it is an employee id;
   * after B4 there is no employee table, and this becomes the worker's own name
   * and charter.
   */
  ownerId: string | null;
  modelProvider: string | null;
  modelId: string | null;
  /**
   * 这个执行体装了哪些工具（原样 JSON）。
   *
   * 原始字符串而不是解析后的对象：语义属于 `work/toolPolicy`，数据层只负责存取。
   * 这样加一条策略不用改表，也不用让仓储认识业务概念。
   */
  policyJson: string;
  status: WorkerStatus;
  spentTokens: number;
  createdAt: number;
  retiredAt: number | null;
}

/** Where an event came from. v1 only wires `manual` and `folder` (§9). */
export type TriggerSource = 'manual' | 'folder' | 'calendar' | 'github' | 'im';

/**
 * The two-level filter of the Super-agent design: a program drops most noise
 * before a model ever sees it, so `pending` is the only state that costs tokens.
 */
/**
 * 一条 Trigger 走到哪一步了。
 *
 * 加 `routed` 是因为 v2 把"交给 Router 判断"和"并进某条线"分成了两件事：
 * v1 的 Router 一次调用就同时判定"要不要做"和"归哪条线"，所以一个 `accepted`
 * 够了；现在语义层是一个真会话，它可能先收下事件、下一轮才决定开哪条线，
 * 也可能判断"这事不需要线"。没有 `routed`，这条事件会在下一轮被再交一次。
 */
export type TriageState = 'pending' | 'routed' | 'accepted' | 'dropped' | 'merged';

export interface TriggerEvent {
  id: string;
  source: TriggerSource;
  kind: string;
  payload: Record<string, unknown>;
  threadId: string | null;
  triage: TriageState;
  createdAt: number;
  triagedAt: number | null;
}

/**
 * 两层过滤各自怎么判（§3.1）。
 *
 * 这是一个**策略**，不是常量：程序层挡掉什么、语义层由谁先看，都能在设置里换。
 * 默认值是"能便宜就便宜，拿不准就交给 Router"，所以换了策略只会影响花多少钱，
 * 不会影响活会不会丢——两层的失败方向都朝着"多问一次"。
 */
export interface TriagePolicy {
  /**
   * 程序层（零 token）：
   * - `noise`：只挡**确定**是噪声的（空内容、自己写出来的回环、窗口内重复），
   *   其余一律往上交。这是默认——它挡错东西的代价是丢活。
   * - `allowlist`：只放行 `sources` 里的来源。适合"我就想让它盯收件箱"的人，
   *   代价是新接的适配器要在这里登记一次，否则它的声音永远进不来。
   */
  fastPath: 'noise' | 'allowlist';
  /** `allowlist` 模式放行的来源；`noise` 模式下不用。 */
  sources: TriggerSource[];
  /**
   * 语义层由谁先看：
   * - `router`：直接交给 Router 会话，它自己判断（默认，最准，花 Router 的上下文）。
   * - `decision`：先用分类器判一遍"这是不是噪声"，通过的才进 Router。判不动的
   *   （模型没配、调用失败）一律放行——省钱的层不许有丢活的权力。
   */
  semantic: 'router' | 'decision';
  /** `decision` 模式：判为噪声的概率达到这个值就丢掉（0~1）。 */
  noiseThreshold: number;
  /**
   * `decision` 模式交给分类器的**策略本身**——一段提示词。
   *
   * 为什么它是配置而不是代码里的一句常量：什么算噪声，取决于你怎么用这个工作台。
   * 一个跑发布的人希望"CI 绿了"是噪声，一个盯代码的人希望它是一条事件。写死在
   * `semanticGate.ts` 里等于让写代码的人替所有人决定。
   */
  semanticPrompt: string;
}

/**
 * 语义层的默认策略。
 *
 * 它只回答一个问题：**这条事件里有没有一件需要动手的事**。写成一"条"而不是一"段"，
 * 是因为分类器要在一批里逐条套用它；写成可编辑的，是因为"什么算噪声"因工作台而异。
 */
export const DEFAULT_SEMANTIC_PROMPT = [
  '噪声 = 里面没有一件需要动手的事：',
  '通知与心跳、状态回执、流水线自己写出来的回环、同一件事的重复投递、',
  '已经处理过的旧消息被重新推送。',
  '只要它可能意味着"有人想要一个结果"，就不是噪声——宁可多问一句。',
].join(' ');

export const DEFAULT_TRIAGE_POLICY: TriagePolicy = {
  fastPath: 'noise',
  sources: ['im', 'folder', 'manual'],
  semantic: 'router',
  semanticPrompt: DEFAULT_SEMANTIC_PROMPT,
  noiseThreshold: 0.7,
};

export interface TriagePolicyPatch {
  fastPath?: TriagePolicy['fastPath'];
  sources?: TriggerSource[];
  semantic?: TriagePolicy['semantic'];
  noiseThreshold?: number;
  semanticPrompt?: string;
}

/** A thread's word to you. The three levels are the whole interface. */
export interface WorkReport {
  id: string;
  threadId: string;
  level: AttentionLevel;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}
