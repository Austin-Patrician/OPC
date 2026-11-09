export type RuntimeQualityTier = "high" | "balanced" | "low"

export interface RuntimeQualityConfig {
  dpr: [number, number]
  shadowMapSize: number
  shadows: boolean
  bloom: boolean
  ao: boolean
  multisampling: number
}

export const RUNTIME_QUALITY: Record<RuntimeQualityTier, RuntimeQualityConfig> = {
  high: { dpr: [1, 1.5], shadowMapSize: 2048, shadows: true, bloom: true, ao: true, multisampling: 2 },
  balanced: { dpr: [1, 1.25], shadowMapSize: 1024, shadows: true, bloom: true, ao: false, multisampling: 0 },
  low: { dpr: [0.85, 1], shadowMapSize: 512, shadows: false, bloom: false, ao: false, multisampling: 0 },
}

const ORDER: RuntimeQualityTier[] = ["low", "balanced", "high"]

export function qualityOverride(search = typeof window === "undefined" ? "" : window.location.search): RuntimeQualityTier | null {
  const value = new URLSearchParams(search).get("runtimeQuality")
  return value === "low" || value === "balanced" || value === "high" ? value : null
}

/** Hysteresis controller: three slow samples down, eight fast samples up, five second lockout. */
export class RuntimeQualityController {
  tier: RuntimeQualityTier
  private slow = 0
  private fast = 0
  private lastChange = -Infinity
  constructor(initial: RuntimeQualityTier = "balanced") { this.tier = initial }
  sample(fps: number, nowMs: number): RuntimeQualityTier {
    if (nowMs - this.lastChange < 5000) return this.tier
    if (fps < 45) { this.slow += 1; this.fast = 0 } else if (fps > 55) { this.fast += 1; this.slow = 0 } else { this.slow = 0; this.fast = 0 }
    const index = ORDER.indexOf(this.tier)
    if (this.slow >= 3 && index > 0) { this.tier = ORDER[index - 1]; this.lastChange = nowMs; this.slow = 0 }
    else if (this.fast >= 8 && index < ORDER.length - 1) { this.tier = ORDER[index + 1]; this.lastChange = nowMs; this.fast = 0 }
    return this.tier
  }
}
