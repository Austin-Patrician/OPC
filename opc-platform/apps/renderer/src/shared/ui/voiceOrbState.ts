import type { AssistantActivityPhase } from '@opc/shared/ipc';

export type VoiceOrbMode =
  | 'idle'
  | 'listening'
  | 'listening-subtle'
  | 'transcribing'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'waiting'
  | 'completed'
  | 'error';

export interface VoiceOrbModeInput {
  activityPhase: AssistantActivityPhase;
  voiceState: 'idle' | 'recording' | 'transcribing';
  ttsSpeaking: boolean;
  userTyping: boolean;
  hasRunningWorker: boolean;
}

/**
 * Resolves the highest-priority visual state for the top VoiceOrb capsule.
 */
export function resolveVoiceOrbMode(input: VoiceOrbModeInput): VoiceOrbMode {
  if (input.voiceState === 'recording') return 'listening';
  if (input.voiceState === 'transcribing') return 'transcribing';
  if (input.ttsSpeaking) return 'speaking';
  if (input.activityPhase === 'typing') return 'speaking';
  if (input.activityPhase === 'waiting_user') return 'waiting';
  if (input.activityPhase === 'error') return 'error';
  if (input.activityPhase === 'thinking' || input.activityPhase === 'organizing') return 'thinking';
  if (
    input.activityPhase === 'working' ||
    input.activityPhase === 'delegating' ||
    input.hasRunningWorker
  ) {
    return 'working';
  }
  if (input.userTyping) return 'listening-subtle';
  if (input.activityPhase === 'completed' || input.activityPhase === 'delivered') {
    return 'completed';
  }
  return 'idle';
}

/**
 * Resolves the i18n key shown beside the orb, elevating local voice/TTS and
 * active worker progress over stale idle/completed phase snapshots.
 */
export function resolveStatusActivityKey(
  input: Omit<VoiceOrbModeInput, 'userTyping'>,
): string {
  if (input.voiceState === 'recording') return 'chat.activity.listening';
  if (input.voiceState === 'transcribing') return 'chat.activity.transcribing';
  const quiescent =
    input.activityPhase === 'idle' ||
    input.activityPhase === 'completed' ||
    input.activityPhase === 'delivered';
  if (input.ttsSpeaking && quiescent) return 'chat.activity.speaking';
  if (input.hasRunningWorker && quiescent) return 'chat.activity.working';
  return `chat.activity.${input.activityPhase}`;
}
