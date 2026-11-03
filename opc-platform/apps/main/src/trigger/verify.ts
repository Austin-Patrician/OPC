import crypto from 'node:crypto';

/**
 * 三种签名校验，一个共同点：**没配密钥不算通过**。
 *
 * 一条 webhook 端点是暴露给外面的东西。首版最容易被写成"没配 secret 就跳过校验"，
 * 那样一个能访问到端口的人就能替你派活、花你的 token。所以这里的约定是：
 *
 * - 配了密钥 → 算签名，比得上就过；
 * - 没配密钥 → **拒绝**，并说明是"没配"而不是"签名不对"——这两种失败的原因不一样，
 *   混在一起用户永远查不出自己漏了哪一步。
 *
 * 比较用定长时间函数：`===` 会在第一个不同的字节上返回，把签名一位一位试出来。
 */
export function hmacHex(secret: string, body: string, algorithm = 'sha256'): string {
  return crypto.createHmac(algorithm, secret).update(body, 'utf8').digest('hex');
}

/** 纯 sha256（飞书的签名是"把几段拼起来再哈希"，不是 HMAC）。 */
export function sha256Hex(body: string): string {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

export function hmacBase64(secret: string, body: string, algorithm = 'sha256'): string {
  return crypto.createHmac(algorithm, secret).update(body, 'utf8').digest('base64');
}

/** 定长比较。长度不同直接 false——那也不是一条能比的时间侧信道。 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** GitHub 的 `sha256=<hex>`；也接受不带前缀的裸 hex。 */
export function matchesGitHubSignature(secret: string, body: string, header: string): boolean {
  const expected = hmacHex(secret, body);
  const given = header.toLowerCase().startsWith('sha256=') ? header.slice(7) : header;
  return safeEqual(expected, given.trim().toLowerCase());
}

/** 取一个 header 的首值。node 会把同名 header 给成数组。 */
export function headerOf(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}
