# 本地缓存层调研：技术选型与边界

> 目标：给「贵、慢、可重算」的派生数据一个统一的本地落脚点，而不是每个模块各自 `new Map()`、各自写文件、各自定 TTL。
>
> 结论先行：**用已经在这儿的 better-sqlite3 做 `cache.db`（元数据 + 小值），大对象放内容寻址的 `cache/blobs/`**，不引入第二个存储引擎。
> 前提是**先有 ≥3 个真实消费者**；只有一个消费者时，不要抽层。

本文的「缓存」指 **app 自己产生的派生数据**（模型列表、OCR 文本、向量、将来的网页抓取结果）。
不指：LLM 响应缓存、Chromium HTTP 缓存、provider 侧 prompt cache——见 §8。

---

## 1. 今天的真实缓存点

先看代码里已经在做缓存的地方，判断这层是否值得抽。

| 位置 | 现在怎么做 | 问题 |
| --- | --- | --- |
| `models/catalog.ts:46` | 模块级 `let cache`，读一次 JSON 编成数组 | 正确（内置静态数据，进程内一次性），不需要持久化 |
| `model_provider.models`（`schema.ts:51`） | provider 的 `/models` 结果整段 JSON 存 DB，注释写明「从不查询、只整读」 | 只在用户点「刷新」时更新（`refreshModels` 的唯一调用方是设置页按钮和一个 probe）；没有 TTL、没有 SWR，换网络/换账号后可能展示几个月前的列表 |
| `runtime/service.ts:243` | 版本探测结果 `Map` + 60s TTL | 正确（版本会变，持久化反而错） |
| `memoryService.retrieve` | 每次召回都 `embed(query)`（远端调用、按 token 计费） | **`embed` 从未被注入**（全仓库没有 `embed:`），所以向量路径目前是死代码；一旦接上，这就是最贵的重复计算 |
| OCR / `ppu-paddle-ocr` | 库内置 `ImageCache`：`Map`、上限 **10 条**、key 是「最多 4096 字节采样算出的 32 位 hash + 长度」 | 重启即失效；**32 位采样 hash 会碰撞**，理论上能把 A 图的文字返回给 B 图；容量小到连续识别 11 张就 miss |
| `generate_image` | 无缓存 | 同一提示词重复生成 = 重复付费（产品上不一定要缓存，见 §7.4） |
| Electron `session` | 默认 HTTP 缓存 | 供应商接口普遍带 `Authorization` 且多返回 `no-store`，命中率基本为 0 |

**判断**：今天只有「模型列表」和「OCR 结果」两个真消费者；加上「向量」和「将来的网页抓取」就是 4 个。

抽象层本身已经落地（§12），它是一层基础设施，不绑定业务：**「≥3 个消费者」这条规则现在约束的是「把哪些数据接进去」，而不是「要不要有这个抽象」**。在只有两个消费者时，先接其中价值最硬的那个（OCR），其余等需求出现再接。

下面按「假设要做」来调研。

## 2. 从场景反推的需求

| 需求 | 为什么 | 影响选型 |
| --- | --- | --- |
| 键值 + 命名空间 | 一个存储、多个业务域，各自配额与清理 | 需要 `ns` 列/前缀 |
| 每条 TTL + 整体 SWR | 模型列表要「先显示旧的、后台刷新」 | 需要 `expires_at` 与「过期但可读」两态 |
| 容量上限 + LRU 淘汰 | 图片/网页/OCR 会无限长 | 需要按 `ns` 统计字节 + 按访问时间淘汰 |
| 跨重启 | 冷启后 OCR 1s、模型列表 1 次 HTTP | 必须落盘 |
| 二进制与小 JSON 混合 | 4KB 向量、几十 KB 文本、1MB 图片 | 大值要么 BLOB 要么文件 |
| 单进程、低 QPS | 每次任务几十次读，不是每秒几万次 | **微秒级差异不重要** |
| 可整体丢弃 | 缓存坏了不能影响正确性 | 必须能 `rm` 后自愈 |
| 可观测 | 证明缓存值得占磁盘 | 命中率、字节数、条目数 |

## 3. 候选技术

### 3.1 实测数据（这台机器，4KB 值 × 5000 键）

环境：Apple Silicon、Electron 43 的 Node 24.18（`ELECTRON_RUN_AS_NODE`）、better-sqlite3（已按 Electron ABI 重编）、`journal_mode=WAL` + `synchronous=NORMAL`、LMDB 3.x。

| 操作 | SQLite（批量事务） | SQLite（每次自动提交） | LMDB | 每键一个文件 | 单个 JSON 全量重写 |
| --- | --- | --- | --- | --- | --- |
| 写 5000 × 4KB | **19.8 µs/op** | 36.5 µs/op | **10.0 µs/op** | 88.1 µs/op | 12.4 ms/op |
| 读 5000 × 4KB | 3.7 µs/op | — | **2.3 µs/op** | 16.8 µs/op | — |
| 读 + 更新 LRU 时间戳 | 16.6 µs/op | — | 未测 | — | — |
| 50 × 1MB 写 / 读 | 25.7 / 4.4 µs | — | — | 3.9 / 4.2 µs | — |

维护成本（另一组，20000 × 4KB 一个事务写入）：

| 操作 | 结果 |
| --- | --- |
| 单事务写 20000 行 | 432.8 ms，**WAL 涨到 89.3 MB** |
| `wal_checkpoint(TRUNCATE)` | 2.8 ms，WAL → 0 |
| 按 LRU 删 5000 行 | 20.1 ms |
| `incremental_vacuum` | 0 ms（因为 `auto_vacuum` 建表后才设，没生效——这是个坑，见 §5.4） |

磁盘占用：SQLite 20MB 数据 + 50MB blob → 72MB；LMDB 20MB 数据 → 39.2MB；5000 个 4KB 文件 → 19.4MB（加 inode/dirent 开销后实际更差）。

**怎么读这组数**：

1. **LMDB 快约 2 倍，但两者都在微秒级**。我们的读路径是「一次任务几十次」，2 倍差距折算下来是「几十微秒 vs 几十微秒」——不足以抵消多一个原生依赖的代价。
2. **批量事务是 SQLite 的生命线**。自动提交慢 1.8 倍；不批量还会把 WAL 撑到几百 MB（上面 89MB 就是一个大事务的代价）。
3. **「读时更新 LRU」比读本身贵 4.5 倍**（16.6 vs 3.7 µs）。所以淘汰时间戳必须节流/批量刷，不能每次命中都 `UPDATE`。
4. **每键一文件天然慢 4–20 倍**，而且没有原子多键操作。
5. **单 JSON 全量重写是灾难**（O(n²)），任何「把缓存存成一个 json 文件」的设计都应否决。
6. 1MB 级 BLOB 放 SQLite 也不慢（25.7/4.4 µs），但见 §5.3 的 WAL 与 vacuum 理由，仍建议外置。

### 3.2 对比表

| | SQLite（better-sqlite3） | LMDB | LevelDB / classic-level | 文件 + 索引 | Chromium HTTP 缓存 | Redis |
| --- | --- | --- | --- | --- | --- | --- |
| 新依赖 | **0**（已在用） | 原生，+1 套预编译 | 原生，+1 | 0 | 0 | 外部进程 |
| TTL / LRU / 配额 | SQL 直接表达 | 自己维护索引 | 自己维护 | 自己维护 | 做不到 | 有，但要服务 |
| 多键原子性 | 有 | 有（事务） | 无 | 无 | — | 有 |
| 大对象 | BLOB 或外置 | 原生 Buffer | 原生 | 原生 | 只 HTTP | 内存为主 |
| 可观测/可修 | `sqlite3` 直接看 | 需要工具 | 需要工具 | 看文件 | DevTools | 需要客户端 |
| 跨平台打包成本 | 已解决（`asarUnpack`） | 重新踩一遍 | 重新踩一遍 | 无 | 无 | 高 |
| 适用规模 | 到 GB 级都够 | 百万级条目 | 写多读少 | 少量大文件 | 仅 HTTP | 多进程 |

**淘汰结论**：

- **RocksDB / Redis**：桌面应用引入外部服务或几十 MB 的库，完全不成立。
- **LevelDB**：写放大与 compaction 停顿换来的顺序写优势，我们没有。
- **LMDB**：技术上更优雅（mmap、零拷贝、MVCC），但收益是 2 倍微秒差，成本是第三个原生依赖 + 一套新的事务语义 + 打包/签名/Windows 上的历史坑。**为「省 2µs」付这个价不划算**。
- **每键一文件**：只有在「值很大、数量很少、生命周期由目录管理」时成立（比如构建产物缓存）。作为通用层，缺原子性、缺配额、Windows 上小文件性能差。
- **`cacache` / `keyv`**：`cacache` 是内容寻址 + 完整性校验，适合纯 blob，但没有 TTL/配额语义；`keyv` 只是适配器，仍需自己解决淘汰。**我们缺的不是 API 外壳，是索引**——而索引正是 SQLite 已经给的。

## 4. 推荐架构

### 4.1 目录

```
<userData>/
  cache.db                 元数据 + ≤64KB 的值
  cache/blobs/ab/cdef…     内容寻址（sha256），只放 >64KB 的值
```

两条硬规则：

- **独立于 `company.db`**。缓存可以被整目录删除、不参与业务备份、不拖慢业务库的 VACUUM。
- **主进程独占写入**。渲染进程要用（例如 OCR 想持久化）就走已有 IPC；不做多写者。

### 4.2 表结构

```sql
CREATE TABLE cache_entry (
  ns           TEXT NOT NULL,      -- 'model.catalog' | 'ocr.text' | 'embed.query' …
  key          TEXT NOT NULL,      -- 规范化后的 sha256(16 进制)，见 §4.6
  kind         TEXT NOT NULL,      -- 'json' | 'text' | 'blob'
  value        TEXT,               -- kind != 'blob' 且 size ≤ 64KB 时内联
  blob         TEXT,               -- 'ab/cdef…'，相对 cache/blobs
  size         INTEGER NOT NULL,   -- 值字节数（不含索引开销）
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,            -- NULL = 不过期
  last_used_at INTEGER NOT NULL,
  hits         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;

CREATE INDEX cache_lru     ON cache_entry (ns, last_used_at);
CREATE INDEX cache_expiry  ON cache_entry (expires_at) WHERE expires_at IS NOT NULL;
```

`WITHOUT ROWID` 让主键即聚簇，条目小、随机读少一次跳转。

### 4.3 API 面

```ts
export interface CacheOptions {
  ttlMs?: number;          // 绝对过期
  staleMs?: number;        // 过期后仍可返回的窗口（SWR）
  maxBytes?: number;       // 该 namespace 的预算，缺省取全局策略
}

export interface CacheStore {
  get<T>(ns: string, key: string): { value: T; stale: boolean } | undefined;
  getOrSet<T>(ns: string, key: string, produce: () => Promise<T>, opts?: CacheOptions): Promise<T>;
  set<T>(ns: string, key: string, value: T, opts?: CacheOptions): void;
  delete(ns: string, key: string): void;
  clear(ns?: string): number;
  stats(): Array<{ ns: string; entries: number; bytes: number; hits: number; misses: number }>;
}
```

- `get` 同步（better-sqlite3 就是同步的），`getOrSet` 异步。
- `stale` 由调用方决定要不要后台刷新——模型列表要，OCR 不要。
- `clear(ns)` 返回删除行数，设置页「清空缓存」直接用它。

### 4.4 写入与淘汰

- 写：`INSERT OR REPLACE`，在**每批 ≤500 行**的事务里提交（实测 20000 行一个事务会把 WAL 撑到 89MB）。
- LRU 时间戳：命中时只更新内存里的 `Map<key, ts>`，每 30s 或每 200 条刷一次库（避免 4.5 倍读放大）。
- 淘汰：`set` 之后若 `ns` 字节数超预算，按 `last_used_at` 分批删最旧的 200 条，直到回到 80% 水位。**读永不触发淘汰**。
- 维护：启动时 `PRAGMA quick_check`；失败就把 `cache.db` 改名成 `.corrupt` 重建（缓存丢了不算事故）。退出前 `wal_checkpoint(TRUNCATE)`。
- 建库时一次性设好 `journal_mode=WAL`、`synchronous=NORMAL`、`auto_vacuum=INCREMENTAL`——**必须在建表前**，事后改要整库 `VACUUM`（本轮实测就踩到了）。

### 4.5 并发

- 进程内 single-flight：`Map<string, Promise>`，同 key 的并发 `getOrSet` 共享一次生产。这不是优化，是**防重复付费**（图片生成、embedding）。
- 单实例锁已经存在，不需要跨进程锁。

### 4.6 一致性规则（比选型更容易出事的地方）

1. **key 必须包含所有会改变结果的东西**。`cacheKey(['v1', ns, providerId, baseUrl, sha256(apiKey), modelId, SHA256(text)])`——注意是 key 的**指纹**，不是 key 明文。
2. **key 里带 schema 版本**（`v1`）。模型换代、prompt 模板改、OCR 参数改，都靠换版本号整体失效，而不是写迁移。
3. **负缓存**：上游失败写 `{ error }` + 30s TTL，避免用户每敲一个键就重试一次网络。
4. **可丢弃**：任何 `get` 都必须能接受「什么都没有」，并且冷路径的耗时是可以接受的——否则它不该叫缓存。
5. **不缓存凭据、不缓存「测试连接」结果、不缓存业务状态**。这些是 `company.db` 的职责，混进来会让「清缓存」变成危险操作。
6. **大对象先算 hash 再写**：内容寻址天然去重，且写文件用 `tmp → rename` 原子落盘。

## 5. 首批接入点

| 接入点 | 做法 | 收益 |
| --- | --- | --- |
| `model.catalog` | 现在只有手动刷新。改成：读缓存立即返回（不管多旧），超过 24h 后台静默 `refreshModels`；刷新失败保留旧值并记录 `stale=true` | 设置页打开即有列表；换代理/断网不再空窗 |
| `ocr.text` | key = `sha256(图片字节) + 模型版本 + recBatchSize/strategy`；不设 TTL，LRU 200 条 / 200MB | 同一张截图第二次识别从 ~1s 降到 ~5ms，且**跨重启**；顺便替掉 ppu 那个 32 位采样 hash（有碰撞风险） |
| `embed.query` | 等 `embed` 接上再做；key = `模型 + sha256(文本)`，TTL 30d | 每次召回省一次付费调用 |
| `web.fetch`（未来） | key = `URL + 方法 + 影响响应的头`，TTL 10min | 给将来的检索工具兜底 |

**不接**：`generate_image`（同提示词要不要同图是产品问题，不是缓存问题）、运行时版本探测（会变，60s 内存 TTL 已足够）。

## 6. 成本

- 代码：约 250–300 行（表 + 打开/自愈 + get/getOrSet + 触摸节流 + 淘汰 + stats + 单测）。
- 依赖：0。
- 打包：0（`cache.db` 在 userData，blob 目录按需创建）。
- 磁盘：默认全局上限 512MB，单 namespace 上限见上表；超了淘汰，不做「无限增长」。

## 7. 什么不该做

1. **不要给缓存加网络能力**。缓存层只回答「有没有、够不够新」，取数逻辑留在调用方。
2. **不要做 LLM 响应缓存**。同 prompt 未必同答（temperature、工具调用、上下文），命中一次就等于篡改一次行为；跨用户/跨任务串味是隐私事故。要省钱应该用 provider 的 prompt cache。
3. **不要复用 Chromium 的 HTTP 缓存**。请求带鉴权头、响应普遍 `no-store`，且无法按业务清理。
4. **不要为了缓存改业务表结构**。`app_setting`、`model_provider.models` 是配置，不是缓存；把 TTL 塞进业务表会让「重置公司」和「清缓存」互相污染。
5. **不要在渲染进程开第二个写者**。

## 8. 风险

| 风险 | 处理 |
| --- | --- |
| 明文落盘（OCR 文本、抓取的网页） | 与 `company.db` 现有做法一致（已是明文 SQLite）；提供「清空缓存」，不参与导出/备份；需要更强保证时再谈加密 |
| 缓存 key 漏字段 → 串数据 | key 统一走 `cacheKey()` 助手 + 版本号；单测覆盖「不同模型/不同账号不共享」 |
| 无限增长 | 全局 + 单 ns 双预算，超限淘汰；`stats()` 在诊断页可见 |
| 库损坏 | `quick_check` → 重建；缓存可丢是设计前提 |
| 过早抽象 | §1 的结论：消费者 <3 时不做，只做局部修补 |

## 9. 分期

| 阶段 | 内容 | 判据 |
| --- | --- | --- |
| **P0** | `cache.db` + `CacheStore` + `model.catalog` SWR + 诊断页容量/命中率 | 设置页冷启 0 网络请求也能出列表 |
| **P1** | `ocr.text`（替掉 ppu 的进程内 LRU） | 同一张图第二次识别 <10ms，且重启后仍命中 |
| **P2** | `embed.query` + `web.fetch`；命中率高的热点再考虑加一层进程内 `Map`（L0） | 命中率数据支持再优化 |

## 10. 一句话结论

存储引擎用 **SQLite**（已经在、打包已解决、SQL 直接给 TTL/LRU/配额），大对象走**内容寻址文件**，接口只留 `get / getOrSet / clear / stats` 五个方法；技术选型不是这个项目的风险，**key 的构成和「什么时候不该缓存」才是**。

---

## 11. 另一类需求：固定业务数据（组织关系、公司名、老板名）

前面十节讨论的是「贵、慢、可重算」的派生数据。另有一类需求是：**数据很小、很稳定、被读得很频繁**——员工花名册、部门树、汇报线、公司名、老板名。它的动机不是「计算贵」，而是「别每次读表」。

这一节的结论与前面相反：**不要用上面这套 `cache.db`，也不要 TTL，用进程内不可变快照 + 写时显式失效。**

### 11.1 先量一遍：慢的不是「读表」

默认种子规模（36 员工 / 6 部门）加上任务累积，实测 `OrgService.list()`：

| 任务数 | `list()` 现状 | 去掉 4 个 task 子查询 | 快照复用 |
| --- | --- | --- | --- |
| 2,000 | 1.0 ms | 43 µs | 5.1 µs |
| 20,000 | **10.5 ms** | 43 µs | 5.1 µs |
| 50,000 | **30.0 ms** | 45 µs | 5.6 µs |

换成 200 员工的规模，趋势一样：

| 规模 | `list()` 现状 | 去掉 task 聚合 | 快照 |
| --- | --- | --- | --- |
| 80 员工 / 10k 任务 | 4.9 ms | 88 µs | 10 µs |
| 200 员工 / 50k 任务 | 30–36 ms | 228 µs | 37 µs |

拆开看 200 员工 / 50k 任务时的成本（每项都是 200 次/轮的累计）：

| 子查询 | 耗时 |
| --- | --- |
| `SUM(cost_usd)` + `COALESCE(finished_at, created_at) >= 今天` | 15.8 ms |
| `SUM(tokens_used)` | 14.1 ms |
| `COUNT(active_tasks)`（被 `idx_task_employee` 覆盖） | 1.1 ms |
| 复用 prepared statement 相对重新 prepare 的节省 | 约 7–12% |

三个结论：

1. **员工表的读取只要 43 µs**，而且和任务数无关。所谓「读表有 IO」在这里不成立：WAL + page cache 下就是内存拷贝。
2. **96–99% 的时间是 4 个关联子查询**，它们随任务数线性增长，并且只在 `OrgPage.tsx` 里被用到（`activeTasks` / `tokensUsed` / `tasksDone` / `costTodayUsd`，全仓库仅此一处）。
3. **复用 prepared statement 不是解药**（省 7–12%）。真正的解药是别在花名册查询里算任务统计。

### 11.2 为什么固定业务数据不能套用 `cache.db`

| 维度 | 固定业务数据 | §1–§10 的缓存目标 |
| --- | --- | --- |
| 值的来源 | 本进程写的表 | 远端/昂贵计算 |
| 变更方式 | 已知的几个写入口 | 外部变化，不可枚举 |
| 陈旧后果 | **在岗状态错误 → 已离职的人还在接任务** | 多一次网络请求 |
| 冷路径成本 | 43 µs | 1 秒 / 一次付费调用 |
| 需要跨重启 | 不需要（重启后 43 µs 就重建好了） | 需要 |

TTL 在这里只做一件事：把「确定的正确」换成「概率的正确」。落盘还要多付序列化、版本、双写的成本，换回 43 µs——不划算。

### 11.3 设计

用 §12 的 `CacheService`，**内存模式 + tag 失效**，不在业务里手写快照：

```ts
// 读：只在真正 miss 时查表
const roster = await cache.getOrLoad('org.roster', 'all', loadRoster, { tags: ['org'] });

// 写：OrgService 每个写方法末尾
cache.invalidateTag('org');
```

`getOrLoad` 保证同一 key 并发只查一次表；`invalidateTag` 精确到条目，没有 TTL 的随机陈旧。

四条硬规则：

1. **快照里不放 task 派生统计**。`onTokens` 每次模型调用都会写一次 `task.tokens_used`，放进去等于每次 token 都让快照失效，命中率归零，还把 30 ms 的查询搬到写路径。
2. **失效必须显式且集中**。全仓库对 `employee` / `department` / `position` 的写都在 `OrgService` 内（唯一例外：`TaskRepository.seedEmployees`，只在 `WorkService` 构造时跑一次；`index.ts` 里的裸 SQL 是 probe 代码，不在产品路径）。因此「写方法末尾 invalidate」是可穷举的，漏了会被单测抓住。
3. **不做 TTL**。同进程内的写是可枚举的，失效是精确的；TTL 只会让「刚招的人查不到」和「刚开的人还在」随机发生。
4. **不落盘**。冷启重建快照 = 43 µs。落盘换不来用户可感知的东西，却换来第二个真相源。

`CompanyService.get()` 同理：它现在每次调用是 **6 条查询（1 次 company + 5 次 `app_setting`）、且每条都重新 prepare，实测 53 µs**；复用 statement 降到 9.4 µs；内存快照 0.06 µs。公司名/老板名只在 `update()` 里变，memo + 一处失效即可。

### 11.4 任务统计怎么办

`activeTasks` / `tokensUsed` / `tasksDone` / `costTodayUsd` 只有 `OrgPage` 用，而 `OrgPage` 只在挂载时 `load()` 一次。按代价从低到高：

| 方案 | 效果 | 代价 |
| --- | --- | --- |
| **A. 从花名册查询里移出，单独 `stats()`**（推荐先做） | 花名册回到 43 µs；组织页多一次查询 | 改 1 个查询 + `OrgMember` 拆类型 |
| B. 统计单独短缓存（2 s） | 组织页也避免重复算 | 需要接受「计数最多旧 2 秒」——只影响展示，不影响权限 |
| C. `task` 上加触发器维护 `employee_task_stats` 表 | 任何地方读统计都变成一次主键查 | schema v11 + 触发器；正确性成本最高 |

A 解决 96–99% 的问题，且**没有陈旧风险**。C 只在「统计要出现在很多页面」时才值得。

### 11.5 与 §1–§10 的关系

两者并存，边界清楚：

- **`cache.db`** 只给「外部来源、昂贵、可丢弃」的数据：OCR 文本、模型列表、将来的网页抓取、embedding。
- **进程内快照** 给「本进程写、很小、读很频繁」的数据：组织关系、公司档案、预算配置。
- 判断依据不是数据大小，而是**谁能改变它**：能穷举写入口 → 快照 + 失效；不能 → TTL/磁盘缓存。

---

## 12. `CacheService`：通用缓存抽象

位置：`apps/main/src/cache/`。

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 对外契约：`CacheService` / `CacheOptions` / `CacheStats` |
| `memoryCache.ts` | L0：进程内 LRU，无 I/O、无定时器 |
| `sqliteCacheStore.ts` | L1：`cache/cache.db`，WAL + tag 索引 + 预算淘汰 |
| `cacheService.ts` | 组合两层：read-through、single-flight、SWR、降级 |
| `cacheService.test.ts` | 20 个用例：TTL、陈旧窗口、并发去重、tag 失效、两级淘汰、跨重启、损坏自愈、磁盘不可用降级 |

### 12.1 接口

```ts
const cache = createCacheService({
  directory: appPaths.cacheDir,  // 省略 = 纯内存，永不碰磁盘
  version: 'v1',                 // 换号即整体失效，不写迁移
  maxBytes: 256 * 1024 * 1024,
  memoryMaxBytes: 64 * 1024 * 1024,
  namespaceMaxBytes: { 'ocr.text': 200 * 1024 * 1024 },
  onError: (error, context) => logger.warn({ error, context }, 'cache'),
});

cache.get<T>(ns, key)                       // { value, stale, ageMs } | undefined
await cache.getOrLoad<T>(ns, key, load, o)  // 读穿 + 并发去重 + 后台刷新
cache.set<T>(ns, key, value, o)
cache.delete(ns, key)
cache.invalidateTag(tag)                    // 返回删除条数
cache.clear(ns?)                            // 返回删除条数
cache.stats()                               // { namespaces: [...], errors }
cache.close()
```

`CacheOptions`：`ttlMs`、`staleMs`、`persist`、`tags`。全部可选，默认「内存、永不过期、无 tag」。

### 12.2 两种语义，不要混用

```ts
// A. 外部派生数据：会过期，跨重启有价值
const models = await cache.getOrLoad('model.catalog', providerId, fetchModels, {
  ttlMs: 24 * 3600_000, staleMs: 7 * 86400_000, persist: true, tags: ['model.catalog'],
});

// B. 本进程拥有的固定数据：不过期，写时失效
const roster = await cache.getOrLoad('org.roster', 'all', loadRoster, { tags: ['org'] });
cache.invalidateTag('org');   // hire / fire / transfer / personnel 之后
```

B 的正确性完全取决于「谁写谁失效」。缓存层不可能知道表被改了——它没有、也不该有 SQLite 钩子。写路径与失效点必须在同一个模块里，否则就会出现「已离职的人还在接任务」这种错误。

### 12.3 实测开销（本机，Electron 43 / Node 24.18）

| 操作 | 耗时 |
| --- | --- |
| 内存 `get` | **0.15 µs** |
| 内存 `set`（36 人名单，11.4 KB，含序列化与计数） | 8.4 µs |
| 落盘 `set`（单行事务） | 55 µs |
| 冷启动：打开 `cache.db` + 反序列化一行 | 0.99 ms |

所以：**固定业务数据用内存模式**。落盘只在「冷路径 ≥ 10 ms」时才划算（OCR 1 s、远端拉取），11.4 KB 的花名册不是。

### 12.4 边界

1. **不缓存 LLM 响应**：同 prompt 未必同答，命中一次就是篡改一次行为。
2. **不做任务内 memo**：那是作用域问题，用局部变量或请求级对象，不要塞进全局缓存。
3. **不缓存凭据**、不缓存「连接测试」的成败（后者用 30 s 负缓存可以，但 key 必须带账号指纹）。
4. **不把缓存当数据库**：任何 `get` 返回 `undefined` 都必须能走通冷路径；做不到就说明它不该叫缓存。
5. **`persist: true` 的值必须能丢**：磁盘是 `cache/` 目录，用户可以直接删。

### 12.5 接入成本

零依赖、零 schema 迁移、零打包改动。业务侧只有两处：

```ts
// 1. bootstrap 构造一次（省略 directory 就是纯内存）
const cache = createCacheService({ directory: appPaths.cacheDir, onError });

// 2. 需要的模块拿它当依赖（不 import 单例，便于测试）
new OrgService(db, cache);
```
