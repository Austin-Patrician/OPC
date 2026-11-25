import { describe, expect, it } from 'vitest';
import {
  VOICE_ORB_PRESETS,
  createInitialAnimState,
  stepAnimState,
} from './voiceOrbRenderer';
import {
  resolveStatusActivityKey,
  resolveVoiceOrbMode,
  type VoiceOrbMode,
} from './voiceOrbState';

const ALL_MODES: VoiceOrbMode[] = [
  'idle',
  'listening',
  'listening-subtle',
  'transcribing',
  'thinking',
  'working',
  'speaking',
  'waiting',
  'completed',
  'error',
];

describe('voiceOrbState', () => {
  it('prioritizes live microphone recording and transcribing above background activity', () => {
    expect(
      resolveVoiceOrbMode({
        activityPhase: 'thinking',
        voiceState: 'recording',
        ttsSpeaking: false,
        userTyping: true,
        hasRunningWorker: true,
      }),
    ).toBe('listening');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'working',
        voiceState: 'transcribing',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: true,
      }),
    ).toBe('transcribing');
  });

  it('maps speaking, waiting, error, thinking, working, typing-subtle, completed, and idle cleanly', () => {
    expect(
      resolveVoiceOrbMode({
        activityPhase: 'idle',
        voiceState: 'idle',
        ttsSpeaking: true,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('speaking');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'typing',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('speaking');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'waiting_user',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: true,
      }),
    ).toBe('waiting');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'error',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('error');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'thinking',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('thinking');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'organizing',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('thinking');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'idle',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: true,
      }),
    ).toBe('working');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'idle',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: true,
        hasRunningWorker: false,
      }),
    ).toBe('listening-subtle');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'completed',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('completed');

    expect(
      resolveVoiceOrbMode({
        activityPhase: 'idle',
        voiceState: 'idle',
        ttsSpeaking: false,
        userTyping: false,
        hasRunningWorker: false,
      }),
    ).toBe('idle');
  });

  it('derives status activity i18n keys with proper precedence', () => {
    expect(
      resolveStatusActivityKey({
        activityPhase: 'idle',
        voiceState: 'recording',
        ttsSpeaking: false,
        hasRunningWorker: false,
      }),
    ).toBe('chat.activity.listening');

    expect(
      resolveStatusActivityKey({
        activityPhase: 'idle',
        voiceState: 'transcribing',
        ttsSpeaking: false,
        hasRunningWorker: false,
      }),
    ).toBe('chat.activity.transcribing');

    expect(
      resolveStatusActivityKey({
        activityPhase: 'completed',
        voiceState: 'idle',
        ttsSpeaking: true,
        hasRunningWorker: false,
      }),
    ).toBe('chat.activity.speaking');

    expect(
      resolveStatusActivityKey({
        activityPhase: 'idle',
        voiceState: 'idle',
        ttsSpeaking: false,
        hasRunningWorker: true,
      }),
    ).toBe('chat.activity.working');

    expect(
      resolveStatusActivityKey({
        activityPhase: 'thinking',
        voiceState: 'idle',
        ttsSpeaking: false,
        hasRunningWorker: true,
      }),
    ).toBe('chat.activity.thinking');
  });

  it('defines luminous presets across all 10 VoiceOrb modes with distinct motion profiles', () => {
    for (const mode of ALL_MODES) {
      const preset = VOICE_ORB_PRESETS[mode];
      expect(preset).toBeDefined();
      for (const rgb of [preset.c1, preset.c2, preset.c3]) {
        expect(rgb).toHaveLength(3);
        for (const ch of rgb) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(255);
        }
      }
    }

    expect(VOICE_ORB_PRESETS.idle.breatheAmp).toBeGreaterThan(0);
    expect(VOICE_ORB_PRESETS.idle.morphAmp).toBeGreaterThan(0);
    expect(VOICE_ORB_PRESETS.thinking.ringAlpha).toBeGreaterThan(0.8);
    expect(VOICE_ORB_PRESETS.thinking.swirlSpeed).toBeGreaterThan(3);
    expect(VOICE_ORB_PRESETS.speaking.bounceAmp).toBeGreaterThan(0);
    expect(VOICE_ORB_PRESETS.listening.rippleMode).toBe('out');
    expect(VOICE_ORB_PRESETS.transcribing.rippleMode).toBe('in');
    expect(VOICE_ORB_PRESETS.completed.rippleMode).toBe('bloom');
  });

  it('smoothly interpolates state across mode transitions and triggers bloom/error impulses', () => {
    const state = createInitialAnimState('idle');
    const [idleR] = state.c1;

    stepAnimState(state, 'thinking', 0, 0.05);
    expect(state.mode).toBe('thinking');
    // Moves toward thinking color smoothly without snapping immediately
    expect(state.c1[0]).toBeGreaterThan(idleR);
    expect(state.c1[0]).toBeLessThan(VOICE_ORB_PRESETS.thinking.c1[0]);
    expect(state.ringAlpha).toBeGreaterThan(0);
    expect(state.ringAlpha).toBeLessThan(VOICE_ORB_PRESETS.thinking.ringAlpha);

    // Entering completed resets bloomAge to 0 + dt
    stepAnimState(state, 'completed', 0, 0.02);
    expect(state.bloomAge).toBeCloseTo(0.02, 4);

    // Entering error resets errorShakeAge to 0 + dt
    stepAnimState(state, 'error', 0, 0.03);
    expect(state.errorShakeAge).toBeCloseTo(0.03, 4);

    // Audio level attacks fast and clamps into [0, 1]
    stepAnimState(state, 'listening', 1.4, 0.05);
    expect(state.level).toBeGreaterThan(0.5);
    expect(state.level).toBeLessThanOrEqual(1);
  });
});
