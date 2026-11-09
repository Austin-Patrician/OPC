export type WorkerStatus = "Running" | "Waiting" | "Idle" | "Failed"

export type RuntimePrototypeVariant =
  | "normal"
  | "waiting"
  | "failed"
  | "stale"
  | "empty"
  | "paused"

export type EventSourceType = "Router" | "Workers" | "Watchdog"

export type GraphNodeId =
  | "incoming"
  | "router"
  | "triage"
  | "worker"
  | "tool"
  | "report"
  | "watchdog"

export interface ExecutionStageItem {
  id: string
  label: string
  sublabel: string
  status: "done" | "running" | "waiting" | "failed" | "idle"
  timestamp: string
}

export interface ToolTraceItem {
  id: string
  toolName: string
  argsDigest: string
  status: "success" | "running" | "waiting" | "failed"
  duration: string
  tokens: string
  targetNodeId: GraphNodeId
}

export interface BusMessageEnvelope {
  id: string
  timestamp: string
  direction: "in" | "out"
  type: string
  correlationId: string
  summary: string
  payloadDigest: string
}

export interface WatchdogWorkerMetrics {
  heartbeatInterval: string
  lastAck: string
  memoryRss: string
  tokenBudget: string
  ttlGuard: "PASS" | "WARN" | "EXPIRED"
  driftMs: string
}

export interface WorkerRuntimeItem {
  id: string
  name: string
  shortCode: string
  status: WorkerStatus
  currentTask: string
  model: string
  thread: string
  elapsed: string
  startedAgo: string
  tokens: string
  correlationId: string
  connectorLabel: string
  waveform: number[]
  newlyUpdated?: boolean
  stages: ExecutionStageItem[]
  traces: ToolTraceItem[]
  messages: BusMessageEnvelope[]
  watchdog: WatchdogWorkerMetrics
}

export interface RuntimeEventRow {
  id: string
  timestamp: string
  source: string
  sourceCategory: EventSourceType
  eventType: string
  summary: string
  correlationId: string
  status: "ok" | "running" | "warn" | "error"
  relatedNodeId: GraphNodeId
  workerId?: string
  isNew?: boolean
}

export const PROTOTYPE_VARIANTS: {
  id: RuntimePrototypeVariant
  label: string
  shortLabel: string
  description: string
}[] = [
  {
    id: "normal",
    label: "1. 正常实时运行 (Normal Live)",
    shortLabel: "正常 LIVE",
    description: "Router 与 2 个 Worker 正常并发处理，Watchdog 心跳稳定",
  },
  {
    id: "waiting",
    label: "2. Worker 等待确认 (Worker Waiting)",
    shortLabel: "Worker 等待",
    description: "Content Worker 处于上游锁或外部确认等待态",
  },
  {
    id: "failed",
    label: "3. Worker 执行失败 (Worker Failed)",
    shortLabel: "Worker 异常",
    description: "Review Worker 触发 schema.validate 断言超时错误",
  },
  {
    id: "stale",
    label: "4. Watchdog 心跳超时 (Watchdog Stale)",
    shortLabel: "心跳超时",
    description: "Watchdog 超过 45s 未收到守护回执，触发告警状态",
  },
  {
    id: "empty",
    label: "5. 空闲无任务系统 (Empty System)",
    shortLabel: "空闲待命",
    description: "当前无活跃线程与队列任务，所有 Worker 处于 Idle 待命态",
  },
  {
    id: "paused",
    label: "6. 暂停实时流更新 (Paused Updates)",
    shortLabel: "已暂停流",
    description: "已冻结画布与事件流滚动，便于开发者排查单帧状态",
  },
]

export const INITIAL_WORKERS: WorkerRuntimeItem[] = [
  {
    id: "worker-research",
    name: "Research Worker",
    shortCode: "W-RES",
    status: "Running",
    currentTask: "整理用户反馈中的重复问题",
    model: "claude-sonnet",
    thread: "feedback-analysis",
    elapsed: "02:14",
    startedAgo: "02:14 ago",
    tokens: "12.4k",
    correlationId: "research-042",
    connectorLabel: "dispatch.task · research-042",
    waveform: [0.35, 0.72, 0.58, 0.92, 0.64, 0.85, 0.78],
    stages: [
      {
        id: "st-1",
        label: "Received task",
        sublabel: "接收 Router 分派任务与上下文指针",
        status: "done",
        timestamp: "14:30:02",
      },
      {
        id: "st-2",
        label: "Loading context",
        sublabel: "挂载历史反馈索引与语义向量片段",
        status: "done",
        timestamp: "14:30:05",
      },
      {
        id: "st-3",
        label: "Calling search tool",
        sublabel: "执行 search.web 与 memory.recall 交叉检索",
        status: "done",
        timestamp: "14:32:09",
      },
      {
        id: "st-4",
        label: "Synthesizing report",
        sublabel: "聚合高频重复问题并生成结构化报告",
        status: "running",
        timestamp: "14:32:11",
      },
    ],
    traces: [
      {
        id: "tr-1",
        toolName: "search.web",
        argsDigest: 'q="duplicate feedback cluster" limit=25',
        status: "success",
        duration: "842ms",
        tokens: "4.2k",
        targetNodeId: "tool",
      },
      {
        id: "tr-2",
        toolName: "memory.recall",
        argsDigest: 'ns="feedback.v2" top_k=12 threshold=0.82',
        status: "success",
        duration: "126ms",
        tokens: "1.8k",
        targetNodeId: "tool",
      },
      {
        id: "tr-3",
        toolName: "report.create",
        argsDigest: 'schema="issue_digest_v1" stream=true',
        status: "running",
        duration: "1.4s...",
        tokens: "6.4k",
        targetNodeId: "report",
      },
    ],
    messages: [
      {
        id: "bm-1",
        timestamp: "14:32:08.104",
        direction: "in",
        type: "dispatch.task",
        correlationId: "research-042",
        summary: "Router 下发反馈去重聚类任务",
        payloadDigest: '{ thread: "feedback-analysis", priority: "P1", budget: 32000 }',
      },
      {
        id: "bm-2",
        timestamp: "14:32:09.230",
        direction: "out",
        type: "tool.invoke",
        correlationId: "research-042",
        summary: "调用本地向量记忆检索 memory.recall",
        payloadDigest: '{ namespace: "feedback.v2", query_vec: "[1536d]" }',
      },
      {
        id: "bm-3",
        timestamp: "14:32:11.018",
        direction: "out",
        type: "report.partial",
        correlationId: "research-042",
        summary: "向 Report 节点输出阶段性聚类摘要 (4/6 簇)",
        payloadDigest: '{ clusters_ready: 4, top_issue: "duplicate_notification" }',
      },
    ],
    watchdog: {
      heartbeatInterval: "5000ms",
      lastAck: "1.2s ago",
      memoryRss: "148.4 MB",
      tokenBudget: "12.4k / 32.0k",
      ttlGuard: "PASS",
      driftMs: "+4ms",
    },
  },
  {
    id: "worker-code",
    name: "Code Worker",
    shortCode: "W-COD",
    status: "Running",
    currentTask: "重构网关鉴权与重试中间件",
    model: "claude-sonnet",
    thread: "gateway-refactor",
    elapsed: "01:38",
    startedAgo: "01:38 ago",
    tokens: "9.8k",
    correlationId: "code-118",
    connectorLabel: "dispatch.task · code-118",
    waveform: [0.48, 0.88, 0.65, 0.74, 0.95, 0.52, 0.82],
    newlyUpdated: true,
    stages: [
      {
        id: "st-c1",
        label: "Received task",
        sublabel: "读取网关模块 AST 与依赖边界",
        status: "done",
        timestamp: "14:30:38",
      },
      {
        id: "st-c2",
        label: "Loading context",
        sublabel: "解析 retry.ts 与单元测试套件",
        status: "done",
        timestamp: "14:30:44",
      },
      {
        id: "st-c3",
        label: "Calling search tool",
        sublabel: "执行 ast.grep 与 patch.apply",
        status: "running",
        timestamp: "14:32:06",
      },
      {
        id: "st-c4",
        label: "Synthesizing report",
        sublabel: "等待单测通过后生成变更报告",
        status: "idle",
        timestamp: "--:--:--",
      },
    ],
    traces: [
      {
        id: "tr-c1",
        toolName: "ast.grep",
        argsDigest: 'pattern="withRetry($$$)" path="src/net"',
        status: "success",
        duration: "194ms",
        tokens: "2.1k",
        targetNodeId: "tool",
      },
      {
        id: "tr-c2",
        toolName: "patch.apply",
        argsDigest: 'file="src/net/retryMiddleware.ts" hunks=3',
        status: "success",
        duration: "310ms",
        tokens: "4.6k",
        targetNodeId: "tool",
      },
      {
        id: "tr-c3",
        toolName: "test.runner",
        argsDigest: 'suite="retryMiddleware.spec.ts"',
        status: "running",
        duration: "920ms...",
        tokens: "3.1k",
        targetNodeId: "report",
      },
    ],
    messages: [
      {
        id: "bm-c1",
        timestamp: "14:30:38.012",
        direction: "in",
        type: "dispatch.task",
        correlationId: "code-118",
        summary: "Router 分派网关重试逻辑重构任务",
        payloadDigest: '{ thread: "gateway-refactor", target: "src/net" }',
      },
      {
        id: "bm-c2",
        timestamp: "14:32:06.410",
        direction: "out",
        type: "tool.invoke",
        correlationId: "code-118",
        summary: "触发沙盒单测运行器 test.runner",
        payloadDigest: '{ filter: "retryMiddleware", timeout_ms: 15000 }',
      },
    ],
    watchdog: {
      heartbeatInterval: "5000ms",
      lastAck: "0.9s ago",
      memoryRss: "212.0 MB",
      tokenBudget: "9.8k / 48.0k",
      ttlGuard: "PASS",
      driftMs: "+2ms",
    },
  },
  {
    id: "worker-content",
    name: "Content Worker",
    shortCode: "W-CNT",
    status: "Waiting",
    currentTask: "等待上游结构化摘要确认",
    model: "gpt-4o-mini",
    thread: "release-notes-cn",
    elapsed: "04:12",
    startedAgo: "04:12 ago",
    tokens: "5.1k",
    correlationId: "content-019",
    connectorLabel: "await.upstream · content-019",
    waveform: [0.22, 0.25, 0.45, 0.22, 0.22, 0.42, 0.22],
    stages: [
      {
        id: "st-w1",
        label: "Received task",
        sublabel: "接收版本变更说明撰写任务",
        status: "done",
        timestamp: "14:28:04",
      },
      {
        id: "st-w2",
        label: "Loading context",
        sublabel: "读取近期合并 PR 列表与里程碑标签",
        status: "done",
        timestamp: "14:28:19",
      },
      {
        id: "st-w3",
        label: "Calling search tool",
        sublabel: "等待 Research Worker 输出问题聚类终稿",
        status: "waiting",
        timestamp: "14:29:50",
      },
      {
        id: "st-w4",
        label: "Synthesizing report",
        sublabel: "待上游解除阻塞后生成发布日志",
        status: "idle",
        timestamp: "--:--:--",
      },
    ],
    traces: [
      {
        id: "tr-w1",
        toolName: "git.log_digest",
        argsDigest: 'range="v1.3.0..HEAD" merges_only=true',
        status: "success",
        duration: "215ms",
        tokens: "3.4k",
        targetNodeId: "tool",
      },
      {
        id: "tr-w2",
        toolName: "sync.await_barrier",
        argsDigest: 'dep_corr="research-042" timeout=300s',
        status: "waiting",
        duration: "142s...",
        tokens: "1.7k",
        targetNodeId: "tool",
      },
    ],
    messages: [
      {
        id: "bm-w1",
        timestamp: "14:29:50.112",
        direction: "out",
        type: "worker.waiting",
        correlationId: "content-019",
        summary: "挂起执行：等待依赖任务 research-042 完成",
        payloadDigest: '{ waiting_on: "research-042", state: "SUSPENDED_BARRIER" }',
      },
    ],
    watchdog: {
      heartbeatInterval: "5000ms",
      lastAck: "2.4s ago",
      memoryRss: "94.2 MB",
      tokenBudget: "5.1k / 16.0k",
      ttlGuard: "WARN",
      driftMs: "+19ms",
    },
  },
  {
    id: "worker-data",
    name: "Data Worker",
    shortCode: "W-DAT",
    status: "Idle",
    currentTask: "待命 · 监听队列分派",
    model: "deepseek-v3",
    thread: "pool-idle-01",
    elapsed: "--:--",
    startedAgo: "idle 14m",
    tokens: "0.0k",
    correlationId: "idle-000",
    connectorLabel: "standby.pool · data-000",
    waveform: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15],
    stages: [
      {
        id: "st-d1",
        label: "Received task",
        sublabel: "工作线程池空闲，等待 Router 唤醒",
        status: "idle",
        timestamp: "--:--:--",
      },
      {
        id: "st-d2",
        label: "Loading context",
        sublabel: "未挂载活跃上下文",
        status: "idle",
        timestamp: "--:--:--",
      },
      {
        id: "st-d3",
        label: "Calling search tool",
        sublabel: "无工具调用",
        status: "idle",
        timestamp: "--:--:--",
      },
      {
        id: "st-d4",
        label: "Synthesizing report",
        sublabel: "无输出任务",
        status: "idle",
        timestamp: "--:--:--",
      },
    ],
    traces: [],
    messages: [
      {
        id: "bm-d1",
        timestamp: "14:18:00.000",
        direction: "out",
        type: "worker.idle",
        correlationId: "idle-000",
        summary: "上一轮批处理完成，已释放显存并归还连接池",
        payloadDigest: '{ pool: "default", warm_cache: true }',
      },
    ],
    watchdog: {
      heartbeatInterval: "10000ms",
      lastAck: "3.1s ago",
      memoryRss: "62.0 MB",
      tokenBudget: "0.0k / 32.0k",
      ttlGuard: "PASS",
      driftMs: "+1ms",
    },
  },
  {
    id: "worker-review",
    name: "Review Worker",
    shortCode: "W-REV",
    status: "Failed",
    currentTask: "校验 schema.validate 断言超时",
    model: "claude-haiku",
    thread: "audit-guard-07",
    elapsed: "00:49",
    startedAgo: "00:49 ago",
    tokens: "3.6k",
    correlationId: "review-089",
    connectorLabel: "error.trap · review-089",
    waveform: [0.65, 0.92, 0.88, 0.98, 0.12, 0.12, 0.12],
    stages: [
      {
        id: "st-f1",
        label: "Received task",
        sublabel: "接收输出结构合规性审查任务",
        status: "done",
        timestamp: "14:31:18",
      },
      {
        id: "st-f2",
        label: "Loading context",
        sublabel: "加载 JSON Schema 严格校验规则集",
        status: "done",
        timestamp: "14:31:21",
      },
      {
        id: "st-f3",
        label: "Calling search tool",
        sublabel: "调用 schema.validate 连续 3 次返回字段缺失",
        status: "failed",
        timestamp: "14:32:07",
      },
      {
        id: "st-f4",
        label: "Synthesizing report",
        sublabel: "任务已中止并上报 Watchdog 异常队列",
        status: "failed",
        timestamp: "14:32:07",
      },
    ],
    traces: [
      {
        id: "tr-f1",
        toolName: "policy.load",
        argsDigest: 'ruleset="strict_output_v3"',
        status: "success",
        duration: "68ms",
        tokens: "0.9k",
        targetNodeId: "tool",
      },
      {
        id: "tr-f2",
        toolName: "schema.validate",
        argsDigest: 'target="draft_payload" max_retries=3',
        status: "failed",
        duration: "4210ms",
        tokens: "2.7k",
        targetNodeId: "tool",
      },
    ],
    messages: [
      {
        id: "bm-f1",
        timestamp: "14:32:07.890",
        direction: "out",
        type: "worker.fault",
        correlationId: "review-089",
        summary: "schema.validate 断言超时，已触发熔断隔离",
        payloadDigest: '{ code: "ERR_SCHEMA_ASSERT_TIMEOUT", retries: 3 }',
      },
    ],
    watchdog: {
      heartbeatInterval: "5000ms",
      lastAck: "42.0s ago",
      memoryRss: "184.6 MB",
      tokenBudget: "3.6k / 16.0k",
      ttlGuard: "EXPIRED",
      driftMs: "+4120ms",
    },
  },
]

export const INITIAL_RUNTIME_EVENTS: RuntimeEventRow[] = [
  {
    id: "ev-1",
    timestamp: "14:32:05",
    source: "Router",
    sourceCategory: "Router",
    eventType: "ingress.accept",
    summary: "Received incoming batch request and initialized triage pipeline",
    correlationId: "research-042",
    status: "ok",
    relatedNodeId: "incoming",
    workerId: "worker-research",
  },
  {
    id: "ev-2",
    timestamp: "14:32:06",
    source: "Router",
    sourceCategory: "Router",
    eventType: "triage.classify",
    summary: "Triage scored complexity=0.78, routed to Research Worker",
    correlationId: "research-042",
    status: "ok",
    relatedNodeId: "triage",
    workerId: "worker-research",
  },
  {
    id: "ev-3",
    timestamp: "14:32:07",
    source: "Review Worker",
    sourceCategory: "Workers",
    eventType: "schema.validate",
    summary: "Review Worker failed on schema.validate assertion timeout (retry 3/3)",
    correlationId: "review-089",
    status: "error",
    relatedNodeId: "tool",
    workerId: "worker-review",
  },
  {
    id: "ev-4",
    timestamp: "14:32:08",
    source: "Router",
    sourceCategory: "Router",
    eventType: "dispatch.task",
    summary: "Router assigned task to Research Worker",
    correlationId: "research-042",
    status: "ok",
    relatedNodeId: "router",
    workerId: "worker-research",
  },
  {
    id: "ev-5",
    timestamp: "14:32:09",
    source: "Research Worker",
    sourceCategory: "Workers",
    eventType: "memory.recall",
    summary: "Research Worker started memory.recall",
    correlationId: "research-042",
    status: "ok",
    relatedNodeId: "tool",
    workerId: "worker-research",
  },
  {
    id: "ev-6",
    timestamp: "14:32:10",
    source: "Watchdog",
    sourceCategory: "Watchdog",
    eventType: "watchdog.heartbeat",
    summary: "Watchdog heartbeat received",
    correlationId: "sys-hb-904",
    status: "ok",
    relatedNodeId: "watchdog",
  },
  {
    id: "ev-7",
    timestamp: "14:32:11",
    source: "Research Worker",
    sourceCategory: "Workers",
    eventType: "report.partial",
    summary: "Research Worker returned partial report",
    correlationId: "research-042",
    status: "running",
    relatedNodeId: "report",
    workerId: "worker-research",
  },
]

export const LIVE_EVENT_POOL: Omit<RuntimeEventRow, "id" | "timestamp" | "isNew">[] = [
  {
    source: "Code Worker",
    sourceCategory: "Workers",
    eventType: "patch.apply",
    summary: "Code Worker applied 3 AST hunks to src/net/retryMiddleware.ts",
    correlationId: "code-118",
    status: "ok",
    relatedNodeId: "tool",
    workerId: "worker-code",
  },
  {
    source: "Research Worker",
    sourceCategory: "Workers",
    eventType: "search.web",
    summary: "Research Worker merged 12 semantic chunks into feedback cluster",
    correlationId: "research-042",
    status: "ok",
    relatedNodeId: "worker",
    workerId: "worker-research",
  },
  {
    source: "Watchdog",
    sourceCategory: "Watchdog",
    eventType: "watchdog.heartbeat",
    summary: "Watchdog heartbeat received · RSS 698MB · drift +3ms",
    correlationId: "sys-hb-905",
    status: "ok",
    relatedNodeId: "watchdog",
  },
  {
    source: "Router",
    sourceCategory: "Router",
    eventType: "queue.rebalance",
    summary: "Router rebalanced priority queue (8 pending, 0 dropped)",
    correlationId: "router-q08",
    status: "ok",
    relatedNodeId: "router",
  },
  {
    source: "Content Worker",
    sourceCategory: "Workers",
    eventType: "sync.await",
    summary: "Content Worker polling upstream barrier research-042",
    correlationId: "content-019",
    status: "warn",
    relatedNodeId: "worker",
    workerId: "worker-content",
  },
]
