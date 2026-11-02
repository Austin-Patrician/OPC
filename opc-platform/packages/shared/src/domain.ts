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
  /** The job's responsibilities, read live from `position → job` at task load. */
  jobDescription?: string;
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
 * Lifecycle of a standing commitment.
 *
 * `paused` and `done` are real states, not labels: a paused project stops feeding
 * memory into its members' context, while `archived` is terminal and hides the
 * project from the index.
 */
export type ProjectStatus = 'planning' | 'active' | 'paused' | 'done' | 'archived';

/** The four states a project can be moved to from the UI; `archived` has its own action. */
export const PROJECT_STATUSES = ['planning', 'active', 'paused', 'done'] as const;

export type EditableProjectStatus = (typeof PROJECT_STATUSES)[number];

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
  /** Structured model selection; absent means "inherit the company default". */
  modelRef?: ModelRef;
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

/**
 * Which tools one employee may call.
 *
 * Deny lists on purpose: an empty policy means "every tool the current runtime can
 * install", so a new extension appears for existing employees instead of being
 * silently disabled for anyone who ever touched a toggle.
 */
export interface EmployeeToolPolicy {
  /** Extension names (e.g. `opc.image`) this employee must not get. */
  disabledExtensions: string[];
  /** Tool names (e.g. `bash`) this employee must not get, even when installed. */
  disabledTools: string[];
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
 * A job: a **company-wide** title ("测试工程师", "CFO"), not a seat in one department.
 *
 * The job is the definition — responsibilities, default skills, default model. How many
 * people a department wants to hire into it is *headcount*, and that lives in
 * `department_job` (see `JobSeat`). Splitting the two is what lets the same title be
 * shared by engineering and QA without duplicating its responsibilities.
 *
 * Editing a job never rewrites someone already in it: skills and model are copied at
 * hire time. Responsibilities are read live and reach the next task.
 */
export interface JobNode {
  id: string;
  title: string;
  level: string;
  /** What this job is responsible for; reaches the agent prompt as the charter. */
  description: string;
  /** Default skills a hire starts with. */
  skills: string[];
  /** Human-readable model snapshot; `''` means "inherit the company default". */
  model: string;
  /** Structured model choice; absent means "inherit the company default". */
  modelRef?: ModelRef;
  /** Live seats across the whole company. */
  filled: number;
  /** Planned seats across departments; 0 means no department claimed one yet. */
  headcount: number;
  /** Which departments plan to hire into this job, with their own cap. */
  seats: JobSeat[];
}

/** One department's plan for one job: "we want N 测试工程师". */
export interface JobSeat {
  departmentId: string;
  departmentName: string;
  headcount: number;
  /** Live seats in this department. */
  filled: number;
}

export interface JobInput {
  title: string;
  level?: string;
  description?: string;
  skills?: string[];
  model?: string;
  modelRef?: ModelRef | null;
}

export interface JobEditInput {
  id: string;
  title?: string;
  level?: string;
  description?: string;
  skills?: string[];
  model?: string;
  /** Omit to keep, `null` to clear (inherit the company default). */
  modelRef?: ModelRef | null;
}

/** Sets one department's headcount for one job; `0` keeps the row as "占住但不招". */
export interface JobSeatInput {
  jobId: string;
  departmentId: string;
  headcount: number;
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
  /** Structured model choice; wins over the legacy free-text `model` label. */
  modelRef?: ModelRef;
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
 * An engine whose models ship *with* the app — the boss cannot pick another one,
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
 * one, otherwise fall back to the price list the boss maintains. The two strict
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

/**
 * ── v2 core: thread / worker / trigger / report ─────────────────────────────
 *
 * The centre of the model moved from `employee` to `thread`
 * (docs/v2/00-audit.md §2): what the boss follows is a line of work, not a
 * person. A `worker` is an execution body that exists for as long as a thread
 * needs it — it has a template and skills, and no career, no rank, no reporting
 * line, and no memory the boss is not allowed to read.
 */

export type ThreadState = 'open' | 'running' | 'waiting' | 'done' | 'failed' | 'archived';

/**
 * How loudly a thread is allowed to reach the boss.
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
  state: ThreadState;
  attention: AttentionLevel;
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
  employeeId: string | null;
  modelProvider: string | null;
  modelId: string | null;
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
export type TriageState = 'pending' | 'accepted' | 'dropped' | 'merged';

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

/** A thread's word to the boss. The three levels are the whole interface. */
export interface WorkReport {
  id: string;
  threadId: string;
  level: AttentionLevel;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
}
