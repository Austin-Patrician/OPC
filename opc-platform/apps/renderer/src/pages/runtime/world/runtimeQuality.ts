/**
 * The runtime uses one high-fidelity render configuration. Performance work is
 * done by reducing CPU scheduling and draw-call overhead; resolution, shadows,
 * AO and post-processing are never silently degraded.
 */
export interface RuntimeRenderConfig {
  dpr: [number, number];
  shadowMapSize: number;
  shadows: boolean;
  bloom: boolean;
  ao: boolean;
  multisampling: number;
}

export const RUNTIME_RENDER_CONFIG: RuntimeRenderConfig = {
  dpr: [1, 1.75],
  shadowMapSize: 4096,
  shadows: true,
  bloom: true,
  ao: true,
  multisampling: 4,
};
