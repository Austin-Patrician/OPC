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

export { formatDurationCompact } from '@/shared/lib/appTime';

/** Highlights steps taking 10s or longer so slow tools stand out at a glance. */
export function isSlowStepMs(ms: number | undefined): boolean {
  return typeof ms === 'number' && ms >= 10_000;
}

/** Strips provider prefixes such as `openai/gpt-5` down to the concise model identifier. */
export function shortModelName(modelLabel: string): string {
  const trimmed = modelLabel.trim();
  if (!trimmed) return '—';
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Formats cumulative token counts into compact, jitter-free telemetry labels (`k` -> `M` -> `B`)
 * so large multi-million-token runs stay compact on a single line.
 */
export function formatTokensCompact(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  const safe = Math.round(tokens);
  if (safe < 1_000) return `${safe}`;
  if (safe < 100_000) {
    return `${(safe / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (safe < 999_500) {
    return `${Math.round(safe / 1_000)}k`;
  }
  if (safe < 10_000_000) {
    return `${(safe / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (safe < 999_500_000) {
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${(safe / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`;
}

/** Formats USD spend concisely according to magnitude (`$0.042`, `$1.25`). */
export function formatCostCompact(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return '$0';
  if (costUsd >= 1) return `$${costUsd.toFixed(2)}`;
  if (costUsd >= 0.01) return `$${costUsd.toFixed(3)}`;
  return `$${costUsd.toFixed(4).replace(/0+$/, '')}`;
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
