/**
 * 摘要里的凭据脱敏。
 *
 * 挂在两个地方：`system_event`（主进程记的故障）与 Watchdog 自己的
 * `watchdog_finding`（子进程记的观察）。两边都会把"某一句话拼出来的错误信息"
 * 落库——而那句话常常带着 `Authorization: Bearer …`、URL 里的 `user:pass@`、
 * 或者 `api_key=…`。只按长度裁剪等于没脱敏。
 *
 * 为什么单独一个模块：子进程要把它打进自己的 bundle，而
 * `systemEventRepository.ts` 是主进程的数据层，不该被它依赖。
 */

/**
 * 抹掉这些形状：
 *
 * - `Bearer xxx` / `Basic xxx`；
 * - `sk-…`、`ghp_…` 这类常见前缀；
 * - URL 里的 `//user:pass@`；
 * - `key=` / `token=` / `secret=` / `password=` 这一类赋值。
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(sk|pk|ghp|gho|glpat|xox[baprs])[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]')
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//[redacted]@')
    .replace(
      /\b([A-Za-z0-9_-]*(?:key|token|secret|password)[A-Za-z0-9_-]*)\s*=\s*[^\s,;]+/gi,
      '$1=[redacted]',
    );
}
