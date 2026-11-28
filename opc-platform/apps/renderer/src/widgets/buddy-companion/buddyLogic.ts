import type { AssistantActivityPhase } from '@opc/shared/ipc';
import type { BuddySizeId } from '@/shared/theme/types';
import type { BuddyClipKey } from '@/shared/ui/BuddyMark';

export interface BuddyBubble {
  text: string;
  actionRoute?: string;
}

export const SIZE_PIXELS: Record<BuddySizeId, number> = {
  sm: 116,
  md: 156,
  lg: 196,
};

export const NEXT_SIZE: Record<BuddySizeId, BuddySizeId> = {
  sm: 'md',
  md: 'lg',
  lg: 'sm',
};

export const BUSY_PHASES: ReadonlySet<AssistantActivityPhase> = new Set([
  'thinking',
  'organizing',
  'delegating',
  'working',
  'typing',
  'waiting_user',
]);

export const POKE_BUBBLE_KEYS = [
  'buddy.bubble.poke1',
  'buddy.bubble.poke2',
  'buddy.bubble.poke3',
  'buddy.bubble.poke4',
] as const;

export const AMBIENT_BUBBLE_KEYS = [
  'buddy.bubble.ambient1',
  'buddy.bubble.ambient2',
  'buddy.bubble.ambient3',
] as const;

export function resolveBuddyClip({
  flustered,
  poked,
  celebrating,
  phase,
  runningWorkerCount,
}: {
  flustered: boolean;
  poked: boolean;
  celebrating: boolean;
  phase: AssistantActivityPhase;
  runningWorkerCount: number;
}): BuddyClipKey {
  if (flustered) return 'error';
  if (poked || celebrating) return 'completed';
  if (phase === 'error') return 'error';
  if (phase === 'thinking' || phase === 'organizing' || phase === 'waiting_user') {
    return 'thinking';
  }
  if (
    runningWorkerCount > 0 ||
    phase === 'working' ||
    phase === 'delegating' ||
    phase === 'typing'
  ) {
    return 'working';
  }
  if (phase === 'completed' || phase === 'delivered') return 'completed';
  return 'idle';
}
