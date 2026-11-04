import type { TriggerReplyTarget, TriggerSource } from '@opc/shared/domain';
import type { ThreadIdentity } from '../router/threadKey';

/**
 * 触发链路（§3 事件驱动）。
 *
 * 一个适配器只管它自己那一家的方言：校验、解析、抽出"这件事是什么 + 它是哪个
 * 外部东西的影子"。它**不判断值不值得做**——那是两层过滤的事（`router/triage.ts`、
 * `router/semanticGate.ts`），也**不开线**——那是 `open_line_of_work` 的事。
 *
 * 这条边界以前没有，所以"加一个新的触发源"意味着改 `router.ts` 的名单，改不对就
 * 静默丢事件。现在新来源 = 新增一个文件 + 注册一行，调度循环一行不动。
 *
 * 三家都还没有 polling（凭 token 主动拉）。它们的第一版都走 webhook：外部平台把事件
 * POST 到本机的 `/hook/<source>`。要让它从公网可达，用户在中间放一条隧道——这一步
 * 我们没有替他做，也不假装做了。
 */

/** 进来的一条 HTTP 请求。适配器只读这个形状，不碰 `node:http` 的细节。 */
export interface TriggerRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** 原始正文，字符串。签名校验必须对**字节**算，所以这里不解析。 */
  body: string;
}

/**
 * 一条外部信号被归一到的东西。
 *
 * `summary` 是给人看的一句话（也会进 Router 的上下文），`text` 是能读到的正文。
 * 两个都不许把整个 webhook 正文塞进来：那正是 Inline & Spill 要处理的体积（§3.3）。
 */
export interface NormalizedTrigger {
  kind: string;
  /** 并线身份。`null` = 这条事件不并线，交给 Router 判断（例如"跟助手说话"）。 */
  identity: ThreadIdentity | null;
  summary: string;
  text?: string;
  /** 谁说的 / 从哪来，用于上下文。 */
  actor?: string;
  /**
   * 外部平台自己的投递 id。同一个 id 只落一条事件：GitHub 与飞书都会重投，
   * 重投不是新工作。
   */
  deliveryId?: string;
  /** 这个信号表示那件事**结束了**（PR 合并、话题关闭）。 */
  terminal?: boolean;
  /** 原始信道的回复地址。Router 只能在拿到它时才有机会回到来源平台。 */
  replyTarget?: TriggerReplyTarget;
}

/**
 * 外部信道的可回复地址。
 *
 * 这里只保存稳定的地址，不保存 access token。具体平台的发送器由应用边界注入；
 * 没有发送器时 Router 必须退回桌面会话，不能伪称已经发到外部平台。
 */
export type { TriggerReplyTarget } from '@opc/shared/domain';

export interface TriggerAdapter {
  /**
   * 路由名：`POST /hook/<id>`。和 `source` 分开，因为飞书与钉钉都是 `im` 来源，
   * 但它们是两条不同的入口、两套签名。
   */
  id: string;
  /** 落库时 `event.source` 的取值。 */
  source: TriggerSource;
  /** 这一家的请求长什么样。看路径或特征 header。 */
  matches(request: TriggerRequest): boolean;
  /**
   * 校验来源。没配密钥时返回 `null`（拒绝且说明了原因），不要让"没配"变成"全放行"。
   * 返回 `true` 才继续。
   */
  verify(request: TriggerRequest): { ok: true } | { ok: false; reason: string };
  /**
   * 一条请求可能讲了好几件事（一个 push 里多个 commit），所以返回数组。
   * 返回空数组是合法的：`ping`、`url_verification` 之外的手续消息都该是空。
   */
  normalize(request: TriggerRequest): NormalizedTrigger[];
  /**
   * 平台在接入时要求原样回一个 challenge（飞书的 `url_verification`）。
   * 需要回 challenge 时返回响应正文，不需要就返回 null。
   */
  challenge?(request: TriggerRequest): string | null;
}
