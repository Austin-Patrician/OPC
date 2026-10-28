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
 * `escalated` is one that never converged and now needs the boss (§7.3 turn limit).
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
  /** Employee-authored turns; the boss's own messages never count (§7.3 ②). */
  turnCount?: number;
  /** Defaults to `open` when absent (payloads written before Step 3). */
  status?: ConversationStatus;
  statusChangedAt?: number;
  messages: Message[];
}

export interface Department {
  id: string;
  name: string;
  code: string;
  color: string;
  description: string;
  leadAgentId: string;
  groupConversationId: string;
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
  /** Review tasks are judged by the boss, never by another manager review. */
  isReview: boolean;
  /** 0 for tasks the boss dispatched directly. */
  depth: number;
  /** How many subtasks this task decomposed into (0 for leaves). */
  childCount: number;
  estTokens: number;
  /** System-owned checker, run in the task workspace. */
  acceptanceCommand: string[];
  /** The assignee's charter, when it has one. */
  persona?: string;
  /** Memories recalled for this run (L2 personal experience, L5 episodic). */
  memories?: { kind: string; content: string; scopeType: string }[];
  /** Current company/department facts (org_fact), most specific last. */
  facts?: { statement: string; scopeType: string }[];
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

/** ── Organisation ───────────────────────────────────────────────────────── */

/**
 * The one company this installation is (§1.3): its `company` row plus the profile
 * preferences that have no column of their own (vision / brand colour / how the
 * boss is addressed). Read and written through `window.opc.company`, so the
 * renderer never keeps a second copy in localStorage.
 */
export interface CompanyProfile {
  id: string;
  /** Displayed in the title bar and on the onboarding business card. */
  name: string;
  /** `content` | `ecommerce` | … — the renderer owns the vocabulary. */
  industry: string;
  vision: string;
  /** Brand palette id; unknown ids fall back to the default palette entry. */
  colorId: string;
  /** What the boss is called in the UI ("老板" by default). */
  bossName: string;
  /** Uploaded company logo as a base64 data URL; absent = brand monogram. */
  logo?: string;
  /** Uploaded boss avatar as a base64 data URL; absent = initials. */
  bossAvatar?: string;
}

/** Partial update; omitted fields keep their stored value. */
export interface CompanyProfilePatch {
  name?: string;
  industry?: string;
  vision?: string;
  colorId?: string;
  bossName?: string;
  /** Data URL; `''` removes the uploaded image. */
  logo?: string;
  bossAvatar?: string;
}

export interface OrgMember {
  id: string;
  name: string;
  role: string;
  level: string;
  /** `active` | `terminated` (employees are never hard-deleted). */
  status: string;
  model: string;
  title: string;
  departmentId: string;
  reportsToEmployeeId?: string;
  /** The job (and its headcount slot) this seat occupies, when the department has one. */
  jobId?: string;
  isHead: boolean;
  /** Covers the head seat while it is vacant; never the same person as `isHead`. */
  isActingHead: boolean;
  activeTasks: number;
  tokensUsed: number;
  skills: string[];
  persona: string;
  /** Data URL of the uploaded portrait, '' when the agent still uses initials. */
  avatar: string;
  /** When the employee joined, ms epoch. */
  hiredAt: number;
  /** When they left, ms epoch; unset while employed. Set by `terminate`, cleared by `reinstate`. */
  terminatedAt?: number;
  /** Probation end, ms epoch; unset means no probation (or already confirmed). */
  probationEndsAt?: number;
  /** Today's model spend in USD, summed from the task ledger. */
  costTodayUsd: number;
  /** Deliverables the system and the manager both accepted. */
  tasksDone: number;
}

/** Everything the boss can do to a person, in one operation rather than three. */
export type PersonnelAction = 'transfer' | 'terminate' | 'reinstate' | 'set-manager' | 'promote' | 'confirm';

export interface PersonnelInput {
  employeeId: string;
  action: PersonnelAction;
  /** transfer: target department; set-manager: manager id ('' clears it). */
  departmentId?: string;
  reportsToEmployeeId?: string;
  /** promote: the new level ("P6"). */
  level?: string;
  /** promote: a new seat title, when the promotion also renames the seat. */
  title?: string;
  /** Why: recorded on the employment event, so the timeline can explain itself. */
  reason?: string;
}

/** An agent package that has been imported but not hired yet. */
export interface AgentCandidate {
  id: string;
  name: string;
  role: string;
  level: string;
  model: string;
  skills: string[];
  persona: string;
  /** Package name / file it came from, for provenance. */
  source: string;
  createdAt: number;
}

export interface DepartmentNode {
  id: string;
  name: string;
  code: string;
  description: string;
  color: string;
  /** Parent department; unset for a top-level department. */
  parentId?: string;
  /** Order among siblings; the chart renders by it, not by creation time. */
  sortOrder: number;
  headEmployeeId?: string;
  /** Covers the seat while it is vacant or its holder is away; never both roles at once. */
  actingHeadEmployeeId?: string;
  members: OrgMember[];
}

/** Everything the boss can change about a department, in one operation. */
export interface DepartmentEditInput {
  id: string;
  name?: string;
  code?: string;
  description?: string;
  /** `null` moves it to the top level; omitted leaves the parent alone. */
  parentId?: string | null;
  sortOrder?: number;
}

/**
 * A headcount slot: "this department has N seats called 高级前端工程师".
 *
 * `headcount` is a cap, not a count — `filled` is derived from live positions, so the
 * two can never disagree. A job with `headcount: 0` is a seat that exists on paper but
 * is not open for hiring yet.
 */
export interface JobNode {
  id: string;
  departmentId: string;
  title: string;
  level: string;
  headcount: number;
  /** Live positions sitting in this job. */
  filled: number;
  description: string;
}

export interface JobInput {
  departmentId: string;
  title: string;
  level?: string;
  headcount?: number;
  description?: string;
}

export interface JobEditInput {
  id: string;
  title?: string;
  level?: string;
  headcount?: number;
  description?: string;
}

/**
 * One entry in an employee's HR timeline.
 *
 * The position table can only tell you "they moved"; it cannot tell you when, who
 * decided, or why — it overwrites nothing but keeps no reason either. This is the
 * append-only record that answers those questions.
 */
export type EmploymentEventKind =
  | 'hired'
  | 'transferred'
  | 'promoted'
  | 'head_appointed'
  | 'head_removed'
  | 'terminated'
  | 'reinstated'
  /** Probation passed: the employee is now permanent. */
  | 'confirmed';

export interface EmploymentEvent {
  id: string;
  employeeId: string;
  kind: EmploymentEventKind;
  fromDepartmentId?: string;
  toDepartmentId?: string;
  fromTitle?: string;
  toTitle?: string;
  fromLevel?: string;
  toLevel?: string;
  /** `'boss'` or an employee id. */
  actor: string;
  reason: string;
  at: number;
}

export interface HireInput {
  name: string;
  role: string;
  level?: string;
  departmentId: string;
  title?: string;
  reportsToEmployeeId?: string;
  isHead?: boolean;
  model?: string;
  skills?: string[];
  /** Free-form charter injected into the agent's system prompt. */
  persona?: string;
  /** Which headcount slot this hire fills; checked against `job.headcount`. */
  jobId?: string;
  /** Probation length in days; 0 / unset means hired as a permanent employee. */
  probationDays?: number;
}

/** One performance review. Scores are 1–5; the overall score is the only required one. */
export type EvaluationKind = 'probation' | 'periodic' | 'project' | 'exit';

export interface Evaluation {
  id: string;
  employeeId: string;
  kind: EvaluationKind;
  /** Period label, e.g. `2026-Q3`; `''` for a one-off review. */
  periodKey: string;
  scoreOverall: number;
  scoreQuality?: number;
  scoreSpeed?: number;
  scoreCost?: number;
  summary: string;
  /** `'boss'` or an employee id. */
  reviewer: string;
  at: number;
}

export interface EvaluationInput {
  employeeId: string;
  kind?: EvaluationKind;
  periodKey?: string;
  scoreOverall: number;
  scoreQuality?: number;
  scoreSpeed?: number;
  scoreCost?: number;
  summary?: string;
  reviewer?: string;
}

/** ── 招聘：试跑面试与员工包 (§4.4) ─────────────────────────────────────── */

export type InterviewStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type InterviewDecision = 'hire' | 'reject';

/**
 * One trial run of a candidate on a real task.
 *
 * `tokensUsed` / `costUsd` / `durationMs` are recorded because they are part of the
 * decision, not trivia: a candidate who is right but ten times as expensive is a
 * different hire from one who is right and cheap.
 */
export interface Interview {
  id: string;
  /** Unset once the candidate has been hired and their market row removed. */
  candidateId?: string;
  /** Snapshot: the interview has to explain itself after the candidate is gone. */
  candidateName: string;
  candidateRole: string;
  taskPrompt: string;
  status: InterviewStatus;
  decision?: InterviewDecision;
  result: string;
  error?: string;
  tokensUsed: number;
  costUsd: number;
  durationMs?: number;
  createdAt: number;
  finishedAt?: number;
}

export type EmployeePackageKind = 'employee' | 'team' | 'company';

/** A recorded export. The file itself lives on disk; this is the receipt. */
export interface EmployeePackageRecord {
  id: string;
  kind: EmployeePackageKind;
  name: string;
  version: string;
  description: string;
  filePath: string;
  /** SHA-256 of the file, so a copied package can prove it is the one exported. */
  fileHash: string;
  fileSize: number;
  /** Who is in the package, and where they sat when it was taken. */
  members: { name: string; role: string; level: string; department: string }[];
  license: string;
  createdAt: number;
}

export interface ExportPackageInput {
  kind: EmployeePackageKind;
  name: string;
  description?: string;
  license?: string;
  /** Empty means the whole company (kind `company`). */
  employeeIds?: string[];
  /** Where to write it; the caller picks the path through a save dialog. */
  filePath: string;
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
 * Your own models ship *with* the app — the boss cannot pick another one, so
 * these are never profiles. They still belong on the runtime page: "is this
 * machine able to run OCR" is machine state, exactly like a missing interpreter.
 */
export interface BundledAsset {
  id: string;
  /** Path relative to the runtime root, e.g. `models/....onnx`. */
  file: string;
  /** Bytes on disk; undefined when the file is missing. */
  bytes?: number;
  /** Size the manifest promises, when it declares one. */
  expectedBytes?: number;
  /**
   * `size` and `corrupt` are different failures: a truncated download and a
   * file that changed under us need different fixes.
   */
  state: 'ok' | 'missing' | 'size' | 'corrupt';
}

export interface BundledRuntime {
  id: string;
  name: string;
  /** What actually runs it, e.g. `onnxruntime-web · WASM/WebGPU`. */
  engine: string;
  version: string;
  /** Absolute directory the assets are read from. */
  root: string;
  /** Bytes on disk across every asset. */
  bytes: number;
  state: 'ok' | 'incomplete' | 'corrupt';
  /** Files were hashed against the manifest, not just sized. */
  verified: boolean;
  checkedAt: number;
  /** The extension and tool this runtime powers, so the page can point at them. */
  extension: string;
  tool: string;
  /** The engine's window is alive (OCR keeps it warm between calls). */
  warm: boolean;
  assets: BundledAsset[];
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
}

/** A chat row is usable unless it was explicitly switched off. */
export function isChatModelEnabled(model: { chatEnabled?: boolean }): boolean {
  return model.chatEnabled !== false;
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

export interface ProviderConfig {
  id: string;
  name: string;
  /** Empty for providers whose SDK default applies. */
  baseUrl: string;
  /** pi api kind, e.g. `openai-completions` / `anthropic-messages`. */
  api: string;
  isCustom: boolean;
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

/** A crossed threshold. One row per budget per level per month (`idx_alert_once`). */
export type BudgetAlertLevel = 'warn' | 'stop';

export interface BudgetAlert {
  id: string;
  budgetId: string;
  scope: BudgetScope;
  scopeId: string;
  periodKey: string;
  level: BudgetAlertLevel;
  usedTokens: number;
  limitTokens: number;
  ratio: number;
  createdAt: number;
}

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
  | 'DECOMPOSE_NOT_SUBORDINATE'
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
  /** Agent id, `'user'` for the boss, `'system'` for HR/system notices. */
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
