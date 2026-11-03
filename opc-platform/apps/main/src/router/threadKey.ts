import type { TriggerSource } from '@opc/shared/domain';

/**
 * 一条工作线的**环境身份**（§3.2）。
 *
 * 原文把「具备连续 / 完整上下文的 request」叫作 Thread：一个 GitHub Pull Request、
 * 同一封邮件下的往来、同一个 IM 话题下的消息。它们的共同点不是"同一个主题"，而是
 * **外面那个东西自己有一个 id**，而这个 id 不会因为我们重启、改主意、换执行体而变化。
 *
 * 所以并线键必须由适配器给出、并且**能被规范化**。上一版直接拿 `payload.threadKey`
 * 当字符串用，于是 `PR #12` 与 `PR  #12` 是两条线，谁也不会发现自己分裂了。
 *
 * 形状是 `<source>:<externalId>`：
 *
 * ```
 * github:acme/api#128         一个 PR
 * github:acme/api#128/comment  PR 下的评论流（与 PR 本身分开，因为它们是两种上下文）
 * im:feishu:oc_xxx:om_yyy     飞书某个话题
 * im:dingtalk:cidAAA:staffBBB 钉钉某个会话
 * calendar:evt_20260714_standup
 * ```
 *
 * 前缀是**来源**，不是给人看的装饰：它是程序层判断"这条事件流的归属确定了吗"的唯一
 * 依据，也是库里 `thread.source` 的来源。把来源放进键里而不是另存一列，是因为一个
 * 身份只在"来自哪"和"外面那个 id"都确定时才确定。
 */

/** 键的总长上限。超了就是适配器把整段正文当 id 塞进来了，那种键不该落库。 */
const MAX_KEY_LENGTH = 200;

export interface ThreadIdentity {
  /** 库里唯一：`github:acme/api#128`。 */
  key: string;
  source: TriggerSource;
  /** 去掉来源前缀的那一段：`acme/api#128`。界面与日志用它，键用它做校验。 */
  externalId: string;
}

/**
 * 造一个身份。
 *
 * 规范化只有两件事：去掉首尾空白、把中间的空白全部删掉。看着粗暴，但并线键是
 * **身份**不是文本——`acme / api` 与 `acme/api` 要是算两条线，那种分裂不会有任何
 * 人发现。外部 id 里出现空白的唯一可能是适配器把一段自然语言当了 id。
 */
export function threadIdentity(source: TriggerSource, externalId: string): ThreadIdentity {
  const cleaned = externalId.trim().replace(/\s+/g, '');
  return { key: `${source}:${cleaned}`, source, externalId: cleaned };
}

/** 从库里读回来的键反解来源。解析不出来就地摊开说，不猜。 */
export function parseThreadKey(key: string): { source: string; externalId: string } | null {
  const at = key.indexOf(':');
  if (at <= 0 || at === key.length - 1) return null;
  return { source: key.slice(0, at), externalId: key.slice(at + 1) };
}

/**
 * 这个键能不能当身份用。
 *
 * 适配器是第一道关，但键也会从 `payload.threadKey`（外部数据）直接进来，所以这里
 * 还要再判一次：必须带来源前缀、必须有非空的外部 id、不能有控制字符、不能太长。
 * 判不过就**不当身份**——那条事件照旧进 Slow Path 让 Router 看一眼，而不是拿一个
 * 半截键去并线。
 */
export function isValidThreadKey(key: unknown): key is string {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return false;
  const parsed = parseThreadKey(key);
  return parsed !== null && parsed.source.length > 0 && parsed.externalId.length > 0;
}
