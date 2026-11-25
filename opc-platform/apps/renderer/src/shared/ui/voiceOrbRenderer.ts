import type { VoiceOrbMode } from './voiceOrbState';

export type RGB = readonly [number, number, number];

export type VoiceOrbRippleMode = 'none' | 'out' | 'soft' | 'in' | 'heartbeat' | 'bloom';

export interface VoiceOrbVisualPreset {
  c1: RGB;
  c2: RGB;
  c3: RGB;
  breatheSpeed: number;
  breatheAmp: number;
  morphSpeed: number;
  morphAmp: number;
  swirlSpeed: number;
  ringAlpha: number;
  ringSpeed: number;
  rippleMode: VoiceOrbRippleMode;
  rippleSpeed: number;
  bounceAmp: number;
  glowAlpha: number;
}

export const VOICE_ORB_PRESETS: Record<VoiceOrbMode, VoiceOrbVisualPreset> = {
  idle: {
    c1: [56, 189, 248],
    c2: [96, 165, 250],
    c3: [45, 212, 191],
    breatheSpeed: 1.9,
    breatheAmp: 0.09,
    morphSpeed: 1.5,
    morphAmp: 0.055,
    swirlSpeed: 1.05,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'none',
    rippleSpeed: 0.6,
    bounceAmp: 0,
    glowAlpha: 0.42,
  },
  listening: {
    c1: [14, 165, 233],
    c2: [34, 211, 238],
    c3: [125, 211, 252],
    breatheSpeed: 2.6,
    breatheAmp: 0.08,
    morphSpeed: 3.1,
    morphAmp: 0.095,
    swirlSpeed: 2.4,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'out',
    rippleSpeed: 0.95,
    bounceAmp: 0,
    glowAlpha: 0.64,
  },
  'listening-subtle': {
    c1: [56, 189, 248],
    c2: [129, 140, 248],
    c3: [56, 217, 212],
    breatheSpeed: 2.4,
    breatheAmp: 0.095,
    morphSpeed: 2.0,
    morphAmp: 0.068,
    swirlSpeed: 1.55,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'soft',
    rippleSpeed: 0.52,
    bounceAmp: 0,
    glowAlpha: 0.5,
  },
  transcribing: {
    c1: [59, 130, 246],
    c2: [34, 211, 238],
    c3: [165, 180, 252],
    breatheSpeed: 3.2,
    breatheAmp: 0.07,
    morphSpeed: 3.4,
    morphAmp: 0.075,
    swirlSpeed: 4.8,
    ringAlpha: 0.92,
    ringSpeed: 4.5,
    rippleMode: 'in',
    rippleSpeed: 0.95,
    bounceAmp: 0,
    glowAlpha: 0.62,
  },
  thinking: {
    c1: [99, 102, 241],
    c2: [168, 85, 247],
    c3: [56, 189, 248],
    breatheSpeed: 2.8,
    breatheAmp: 0.075,
    morphSpeed: 3.2,
    morphAmp: 0.085,
    swirlSpeed: 4.3,
    ringAlpha: 0.96,
    ringSpeed: 3.7,
    rippleMode: 'none',
    rippleSpeed: 0,
    bounceAmp: 0,
    glowAlpha: 0.64,
  },
  working: {
    c1: [59, 130, 246],
    c2: [20, 184, 166],
    c3: [56, 189, 248],
    breatheSpeed: 2.5,
    breatheAmp: 0.08,
    morphSpeed: 2.6,
    morphAmp: 0.072,
    swirlSpeed: 2.8,
    ringAlpha: 0.84,
    ringSpeed: 2.4,
    rippleMode: 'none',
    rippleSpeed: 0,
    bounceAmp: 0,
    glowAlpha: 0.56,
  },
  speaking: {
    c1: [56, 189, 248],
    c2: [52, 211, 153],
    c3: [99, 102, 241],
    breatheSpeed: 3.6,
    breatheAmp: 0.11,
    morphSpeed: 4.0,
    morphAmp: 0.11,
    swirlSpeed: 3.1,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'out',
    rippleSpeed: 0.72,
    bounceAmp: 1.0,
    glowAlpha: 0.66,
  },
  waiting: {
    c1: [245, 158, 11],
    c2: [251, 191, 36],
    c3: [251, 146, 60],
    breatheSpeed: 2.2,
    breatheAmp: 0.09,
    morphSpeed: 1.9,
    morphAmp: 0.055,
    swirlSpeed: 1.4,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'heartbeat',
    rippleSpeed: 0.55,
    bounceAmp: 0,
    glowAlpha: 0.58,
  },
  completed: {
    c1: [16, 185, 129],
    c2: [52, 211, 153],
    c3: [45, 212, 191],
    breatheSpeed: 1.8,
    breatheAmp: 0.085,
    morphSpeed: 1.5,
    morphAmp: 0.05,
    swirlSpeed: 1.1,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'bloom',
    rippleSpeed: 0.9,
    bounceAmp: 0,
    glowAlpha: 0.54,
  },
  error: {
    c1: [244, 63, 94],
    c2: [251, 113, 133],
    c3: [225, 29, 72],
    breatheSpeed: 1.7,
    breatheAmp: 0.06,
    morphSpeed: 1.4,
    morphAmp: 0.04,
    swirlSpeed: 0.85,
    ringAlpha: 0,
    ringSpeed: 0,
    rippleMode: 'none',
    rippleSpeed: 0,
    bounceAmp: 0,
    glowAlpha: 0.5,
  },
};

export interface VoiceOrbAnimState {
  mode: VoiceOrbMode;
  c1: [number, number, number];
  c2: [number, number, number];
  c3: [number, number, number];
  breatheAmp: number;
  morphAmp: number;
  swirlSpeed: number;
  ringAlpha: number;
  bounceAmp: number;
  glowAlpha: number;
  level: number;
  time: number;
  swirlPhase: number;
  ringPhase: number;
  morphPhase: number;
  ripplePhase: number;
  bloomAge: number;
  errorShakeAge: number;
}

const CONTOUR_STEPS = 48;
const PEARLESCENT_HIGHLIGHT: RGB = [235, 250, 255];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

function lerpRgbInPlace(target: [number, number, number], dest: RGB, alpha: number): void {
  target[0] = lerp(target[0], dest[0], alpha);
  target[1] = lerp(target[1], dest[1], alpha);
  target[2] = lerp(target[2], dest[2], alpha);
}

function rgba(color: RGB, alpha: number): string {
  const r = Math.round(Math.max(0, Math.min(255, color[0])));
  const g = Math.round(Math.max(0, Math.min(255, color[1])));
  const b = Math.round(Math.max(0, Math.min(255, color[2])));
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha).toFixed(3)})`;
}

function darkenRgb(color: RGB, factor: number): RGB {
  return [color[0] * factor, color[1] * factor, color[2] * factor];
}

function easeOutCubic(t: number): number {
  const inv = 1 - clamp01(t);
  return 1 - inv * inv * inv;
}

export function createInitialAnimState(mode: VoiceOrbMode = 'idle'): VoiceOrbAnimState {
  const preset = VOICE_ORB_PRESETS[mode];
  return {
    mode,
    c1: [preset.c1[0], preset.c1[1], preset.c1[2]],
    c2: [preset.c2[0], preset.c2[1], preset.c2[2]],
    c3: [preset.c3[0], preset.c3[1], preset.c3[2]],
    breatheAmp: preset.breatheAmp,
    morphAmp: preset.morphAmp,
    swirlSpeed: preset.swirlSpeed,
    ringAlpha: preset.ringAlpha,
    bounceAmp: preset.bounceAmp,
    glowAlpha: preset.glowAlpha,
    level: 0,
    time: 0,
    swirlPhase: 0,
    ringPhase: 0,
    morphPhase: 0,
    ripplePhase: 0,
    bloomAge: mode === 'completed' ? 0 : 99,
    errorShakeAge: mode === 'error' ? 0 : 99,
  };
}

export function stepAnimState(
  state: VoiceOrbAnimState,
  targetMode: VoiceOrbMode,
  rawLevel: number,
  dt: number,
  nowTrigger?: boolean,
): VoiceOrbAnimState {
  const safeDt = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0.016;
  const targetPreset = VOICE_ORB_PRESETS[targetMode];

  const modeChanged = state.mode !== targetMode;
  if (modeChanged || nowTrigger) {
    if (targetMode === 'completed') {
      state.bloomAge = 0;
    }
    if (targetMode === 'error') {
      state.errorShakeAge = 0;
    }
  }
  state.mode = targetMode;

  const dampAlpha = 1 - Math.exp(-safeDt * 5.8);
  lerpRgbInPlace(state.c1, targetPreset.c1, dampAlpha);
  lerpRgbInPlace(state.c2, targetPreset.c2, dampAlpha);
  lerpRgbInPlace(state.c3, targetPreset.c3, dampAlpha);

  state.breatheAmp = lerp(state.breatheAmp, targetPreset.breatheAmp, dampAlpha);
  state.morphAmp = lerp(state.morphAmp, targetPreset.morphAmp, dampAlpha);
  state.swirlSpeed = lerp(state.swirlSpeed, targetPreset.swirlSpeed, dampAlpha);
  state.ringAlpha = lerp(state.ringAlpha, targetPreset.ringAlpha, dampAlpha);
  state.bounceAmp = lerp(state.bounceAmp, targetPreset.bounceAmp, dampAlpha);
  state.glowAlpha = lerp(state.glowAlpha, targetPreset.glowAlpha, dampAlpha);

  const clampedLevel = clamp01(rawLevel);
  const levelRate = clampedLevel > state.level ? 18 : 7;
  const levelAlpha = 1 - Math.exp(-safeDt * levelRate);
  state.level = lerp(state.level, clampedLevel, levelAlpha);

  state.time += safeDt;
  state.swirlPhase += safeDt * (state.swirlSpeed + state.level * 1.8);
  state.ringPhase += safeDt * (targetPreset.ringSpeed > 0 ? targetPreset.ringSpeed : 1.2);
  state.morphPhase += safeDt * (targetPreset.morphSpeed + state.level * 1.4);
  state.ripplePhase +=
    safeDt * ((targetPreset.rippleSpeed > 0 ? targetPreset.rippleSpeed : 0.65) + state.level * 0.4);
  state.bloomAge = Math.min(99, state.bloomAge + safeDt);
  state.errorShakeAge = Math.min(99, state.errorShakeAge + safeDt);

  return state;
}

function contourPoint(
  index: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  morphAmp: number,
  morphPhase: number,
): [number, number] {
  const theta = (index / CONTOUR_STEPS) * Math.PI * 2;
  const harmonic =
    morphAmp * 0.55 * Math.sin(2 * theta + morphPhase) +
    morphAmp * 0.35 * Math.cos(3 * theta - morphPhase * 1.45) +
    morphAmp * 0.22 * Math.sin(5 * theta + morphPhase * 2.1);
  const scale = 1 + harmonic;
  return [cx + Math.cos(theta) * rx * scale, cy + Math.sin(theta) * ry * scale];
}

function buildMorphContourPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  morphAmp: number,
  morphPhase: number,
): void {
  const [firstX, firstY] = contourPoint(0, cx, cy, rx, ry, morphAmp, morphPhase);
  const [prevEndX, prevEndY] = contourPoint(
    CONTOUR_STEPS - 1,
    cx,
    cy,
    rx,
    ry,
    morphAmp,
    morphPhase,
  );

  ctx.beginPath();
  ctx.moveTo((prevEndX + firstX) * 0.5, (prevEndY + firstY) * 0.5);

  let curX = firstX;
  let curY = firstY;
  for (let i = 0; i < CONTOUR_STEPS; i += 1) {
    const [nextX, nextY] = contourPoint(
      (i + 1) % CONTOUR_STEPS,
      cx,
      cy,
      rx,
      ry,
      morphAmp,
      morphPhase,
    );
    ctx.quadraticCurveTo(curX, curY, (curX + nextX) * 0.5, (curY + nextY) * 0.5);
    curX = nextX;
    curY = nextY;
  }
  ctx.closePath();
}

function drawRingStroke(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: RGB,
  alpha: number,
  lineWidth: number,
): void {
  if (alpha <= 0.01 || radius <= 0.5) return;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = rgba(color, alpha);
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function drawRipples(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  baseR: number,
  state: VoiceOrbAnimState,
  preset: VoiceOrbVisualPreset,
  cadence: number,
  isDark: boolean,
): void {
  const mode = preset.rippleMode;
  const alphaBoost = isDark ? 1.0 : 0.88;

  if (mode === 'out') {
    const maxR = baseR * (1.95 + state.level * 0.38);
    const activityAmp =
      state.mode === 'speaking' ? 0.55 + cadence * 0.45 : 0.62 + state.level * 0.55;
    for (let i = 0; i < 3; i += 1) {
      const p = (state.ripplePhase + i / 3) % 1;
      const r = lerp(baseR * 0.96, maxR, easeOutCubic(p));
      const a = Math.sin(p * Math.PI) * 0.52 * activityAmp * alphaBoost;
      drawRingStroke(ctx, cx, cy, r, state.c1, a, 1.25);
    }
    return;
  }

  if (mode === 'soft') {
    const p = state.ripplePhase % 1;
    const r = lerp(baseR * 0.96, baseR * 1.72, easeOutCubic(p));
    const a = (1 - p) * Math.sin(p * Math.PI) * 0.36 * alphaBoost;
    drawRingStroke(ctx, cx, cy, r, state.c2, a, 1.15);
    return;
  }

  if (mode === 'in') {
    for (let i = 0; i < 2; i += 1) {
      const p = (state.ripplePhase + i * 0.5) % 1;
      const r = lerp(baseR * 1.9, baseR * 0.92, easeOutCubic(p));
      const a = Math.sin(p * Math.PI) * 0.54 * alphaBoost;
      drawRingStroke(ctx, cx, cy, r, state.c2, a, 1.2);
    }
    return;
  }

  if (mode === 'heartbeat') {
    const cycle = state.ripplePhase % 1;
    const offsets = [0, 0.19];
    for (const offset of offsets) {
      const p = (cycle - offset + 1) % 1;
      if (p < 0.72) {
        const norm = p / 0.72;
        const r = lerp(baseR * 0.96, baseR * 1.88, easeOutCubic(norm));
        const a = (1 - norm) * 0.52 * alphaBoost;
        drawRingStroke(ctx, cx, cy, r, state.c2, a, 1.25);
      }
    }
    return;
  }

  if (mode === 'bloom' && state.bloomAge < 1.15) {
    const p = state.bloomAge / 1.15;
    const r = lerp(baseR * 0.95, baseR * 2.02, easeOutCubic(p));
    const a = (1 - p) * 0.72 * alphaBoost;
    drawRingStroke(ctx, cx, cy, r, state.c2, a, 1.5);
  }
}

function drawAuroraBlob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: RGB,
  alpha: number,
): void {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, rgba(color, alpha));
  grad.addColorStop(0.55, rgba(color, alpha * 0.42));
  grad.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawInternalVortexRibbons(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  state: VoiceOrbAnimState,
): void {
  const intensity = clamp01((state.ringAlpha - 0.05) / 0.9);
  for (let i = 0; i < 2; i += 1) {
    const baseAngle = state.swirlPhase * (1.25 + i * 0.35) + i * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, r * (0.56 - i * 0.14), baseAngle, baseAngle + Math.PI * 0.95);
    ctx.strokeStyle = rgba(i === 0 ? state.c3 : PEARLESCENT_HIGHLIGHT, 0.34 * intensity);
    ctx.lineWidth = Math.max(1.2, r * 0.18);
    ctx.lineCap = 'round';
    ctx.stroke();
  }
}

function drawOrbitalCometArc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  orbitR: number,
  state: VoiceOrbAnimState,
  isDark: boolean,
): void {
  const segments = 14;
  const arcSpan = (145 * Math.PI) / 180;
  const headAngle = state.ringPhase;
  const tailAngle = headAngle - arcSpan;
  const brightness = isDark ? 1.0 : 0.92;

  ctx.lineCap = 'round';
  for (let i = 0; i < segments; i += 1) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const a0 = lerp(tailAngle, headAngle, t0);
    const a1 = lerp(tailAngle, headAngle, t1);
    const taper = Math.pow(t1, 1.55);
    const color: RGB = [
      lerp(state.c2[0], state.c3[0], t1),
      lerp(state.c2[1], state.c3[1], t1),
      lerp(state.c2[2], state.c3[2], t1),
    ];

    ctx.beginPath();
    ctx.arc(cx, cy, orbitR, a0, a1 + 0.015);
    ctx.strokeStyle = rgba(color, state.ringAlpha * taper * brightness);
    ctx.lineWidth = 0.7 + taper * 1.45;
    ctx.stroke();
  }

  const headX = cx + Math.cos(headAngle) * orbitR;
  const headY = cy + Math.sin(headAngle) * orbitR;

  const sparkGlow = ctx.createRadialGradient(headX, headY, 0, headX, headY, 4.2);
  sparkGlow.addColorStop(0, rgba(PEARLESCENT_HIGHLIGHT, state.ringAlpha * 0.85));
  sparkGlow.addColorStop(0.5, rgba(state.c3, state.ringAlpha * 0.45));
  sparkGlow.addColorStop(1, rgba(state.c3, 0));
  ctx.fillStyle = sparkGlow;
  ctx.beginPath();
  ctx.arc(headX, headY, 4.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = rgba(PEARLESCENT_HIGHLIGHT, state.ringAlpha * 0.98);
  ctx.beginPath();
  ctx.arc(headX, headY, 1.5, 0, Math.PI * 2);
  ctx.fill();
}

export function drawVoiceOrbFrame(
  ctx: CanvasRenderingContext2D,
  stageSize: number,
  state: VoiceOrbAnimState,
  isDark: boolean,
): void {
  const preset = VOICE_ORB_PRESETS[state.mode];
  const baseR = stageSize * 0.245;

  const cadence =
    0.5 + 0.3 * Math.sin(state.time * 7.2) + 0.2 * Math.sin(state.time * 11.7 + 1.1);
  const bounceY = state.bounceAmp > 0.01 ? -(cadence - 0.35) * 2.4 * state.bounceAmp : 0;

  let heartbeatScale = 0;
  if (state.mode === 'waiting') {
    const beatCycle = state.ripplePhase % 1;
    if (beatCycle < 0.14) {
      heartbeatScale = Math.sin((beatCycle / 0.14) * Math.PI) * 0.11;
    } else if (beatCycle >= 0.19 && beatCycle < 0.33) {
      heartbeatScale = Math.sin(((beatCycle - 0.19) / 0.14) * Math.PI) * 0.075;
    }
  }

  const shakeX =
    state.errorShakeAge < 0.55
      ? Math.exp(-state.errorShakeAge * 7) * Math.sin(state.errorShakeAge * 44) * 2.2
      : 0;

  const cx = stageSize * 0.5 + shakeX;
  const cy = stageSize * 0.5 + bounceY;

  const breathe = Math.sin(state.time * preset.breatheSpeed) * state.breatheAmp;
  const speakingBoost = state.bounceAmp > 0.01 ? (cadence - 0.5) * 0.09 * state.bounceAmp : 0;
  const radius = baseR * (1 + breathe + state.level * 0.22 + heartbeatScale + speakingBoost);

  const scaleX = 1 - (cadence - 0.5) * 0.14 * state.bounceAmp;
  const scaleY = 1 + (cadence - 0.5) * 0.16 * state.bounceAmp;
  const rx = radius * scaleX;
  const ry = radius * scaleY;
  const effectiveMorph = state.morphAmp + state.level * 0.095;

  ctx.clearRect(0, 0, stageSize, stageSize);

  // Layer 0: Ambient Halo
  const haloR = baseR * (1.85 + state.level * 0.45);
  const haloPeak = state.glowAlpha * (isDark ? 0.44 : 0.3);
  const haloGrad = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, haloR);
  haloGrad.addColorStop(0, rgba(state.c1, haloPeak));
  haloGrad.addColorStop(0.55, rgba(state.c2, haloPeak * 0.42));
  haloGrad.addColorStop(1, rgba(state.c2, 0));
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
  ctx.fill();

  // Layer 1: Concentric Fluid Ripples
  drawRipples(ctx, cx, cy, baseR, state, preset, cadence, isDark);

  // Layer 2: Clipped Organic Liquid Sphere
  ctx.save();
  buildMorphContourPath(ctx, cx, cy, rx, ry, effectiveMorph, state.morphPhase);
  ctx.clip();

  const deepEdge = darkenRgb(state.c2, isDark ? 0.58 : 0.72);
  const sphereGrad = ctx.createRadialGradient(
    cx - rx * 0.22,
    cy - ry * 0.22,
    radius * 0.08,
    cx,
    cy,
    radius * 1.15,
  );
  sphereGrad.addColorStop(0, rgba(state.c1, 1));
  sphereGrad.addColorStop(0.58, rgba(state.c2, 1));
  sphereGrad.addColorStop(1, rgba(deepEdge, 1));
  ctx.fillStyle = sphereGrad;
  ctx.fillRect(cx - radius * 1.4, cy - radius * 1.4, radius * 2.8, radius * 2.8);

  // Orbiting internal luminous aurora blobs
  ctx.globalCompositeOperation = 'screen';
  const s = state.swirlPhase;
  drawAuroraBlob(
    ctx,
    cx + Math.cos(s * 1.1) * rx * 0.42,
    cy + Math.sin(s * 1.35) * ry * 0.4,
    radius * 0.78,
    state.c3,
    isDark ? 0.75 : 0.68,
  );
  drawAuroraBlob(
    ctx,
    cx + Math.cos(s * 0.85 + 2.15) * rx * 0.46,
    cy + Math.sin(s * 1.15 + 1.4) * ry * 0.42,
    radius * 0.72,
    state.c2,
    isDark ? 0.62 : 0.56,
  );
  drawAuroraBlob(
    ctx,
    cx + Math.sin(s * 1.55 + 4.1) * rx * 0.34,
    cy + Math.cos(s * 1.25 + 3.2) * ry * 0.34,
    radius * 0.56,
    PEARLESCENT_HIGHLIGHT,
    isDark ? 0.55 : 0.62,
  );

  if (state.ringAlpha > 0.05) {
    drawInternalVortexRibbons(ctx, cx, cy, radius, state);
  }

  ctx.globalCompositeOperation = 'source-over';

  // Upper-left Fresnel glass highlight crescent
  const sheenGrad = ctx.createRadialGradient(
    cx - rx * 0.34,
    cy - ry * 0.36,
    0,
    cx - rx * 0.28,
    cy - ry * 0.28,
    radius * 0.7,
  );
  sheenGrad.addColorStop(0, isDark ? 'rgba(255, 255, 255, 0.62)' : 'rgba(255, 255, 255, 0.76)');
  sheenGrad.addColorStop(0.42, 'rgba(255, 255, 255, 0.16)');
  sheenGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = sheenGrad;
  ctx.fillRect(cx - radius * 1.4, cy - radius * 1.4, radius * 2.8, radius * 2.8);

  // Fine translucent inner rim
  buildMorphContourPath(ctx, cx, cy, rx, ry, effectiveMorph, state.morphPhase);
  ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.34)' : 'rgba(255, 255, 255, 0.44)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.restore();

  // Layer 3: Orbital Luminous Comet Arc
  if (state.ringAlpha > 0.02) {
    drawOrbitalCometArc(ctx, cx, cy, baseR + 3.0, state, isDark);
  }
}
