/**
 * Formats step duration milliseconds cleanly for high-density telemetry:
 * - < 1000ms  -> `240ms`
 * - 1s..59.9s -> `33.8s`
 * - 1m..59m   -> `1m 12s` (or `2m` when exact)
 * - >= 1h     -> `1h 05m`
 */
export function formatStepMs(ms: number): string {
  const safeMs = Math.max(0, Math.round(ms));
  if (safeMs < 1000) return `${safeMs}ms`;
  if (safeMs < 60_000) {
    return `${(safeMs / 1000).toFixed(1)}s`;
  }
  const totalSec = Math.floor(safeMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (totalMin < 60) {
    return secs === 0 ? `${totalMin}m` : `${totalMin}m ${String(secs).padStart(2, '0')}s`;
  }
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return `${hrs}h ${String(mins).padStart(2, '0')}m`;
}

/** Highlights steps taking 10s or longer so slow tools stand out at a glance. */
export function isSlowStepMs(ms: number | undefined): boolean {
  return typeof ms === 'number' && ms >= 10_000;
}

/**
 * Extracts readable Markdown from `reply_to_user` serialized `Args:\n{...}` telemetry detail.
 * Returns `null` for non-reply tools or unparseable payloads so machine output stays raw monospace.
 */
export function extractReplyMarkdown(entryName: string, detail?: string): string | null {
  if (entryName.trim() !== 'reply_to_user' || !detail) return null;
  const match = detail.match(/Args:\s*\n([\s\S]*?)(?:\n\nResult:|\s*$)/);
  const jsonText = match?.[1]?.trim();
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (Array.isArray(parsed.blocks)) {
      const parts = parsed.blocks
        .flatMap((block) => {
          if (!block || typeof block !== 'object') return [];
          const item = block as Record<string, unknown>;
          if (item.type === 'markdown' && typeof item.text === 'string' && item.text.trim()) {
            return [item.text.trim()];
          }
          if (typeof item.text === 'string' && item.text.trim()) {
            return [item.text.trim()];
          }
          return [];
        });
      return parts.length > 0 ? parts.join('\n\n') : null;
    }
    if (typeof parsed.text === 'string' && parsed.text.trim()) {
      return parsed.text.trim();
    }
  } catch {
    return null;
  }
  return null;
}
