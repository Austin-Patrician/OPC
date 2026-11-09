import { createContext, useContext, useEffect, useRef } from 'react';
import type { RuntimeSim } from './runtimeSim';

export const SimContext = createContext<RuntimeSim | null>(null);
type Callback = (time: number, dt: number) => void;
type ScheduledCallback = { callback: Callback; interval: number; elapsed: number };
class AnimationScheduler {
  private callbacks = new Set<ScheduledCallback>();
  add(callback: Callback, fps = 30) {
    const item: ScheduledCallback = { callback, interval: 1 / Math.max(1, fps), elapsed: 0 };
    this.callbacks.add(item);
    return () => { this.callbacks.delete(item); };
  }
  tick(time: number, dt: number) {
    this.callbacks.forEach((item) => {
      item.elapsed += dt;
      if (item.elapsed < item.interval) return;
      const callbackDt = item.elapsed;
      item.elapsed = 0;
      item.callback(time, callbackDt);
    });
  }
}
const schedulers = new WeakMap<RuntimeSim, AnimationScheduler>();
export const schedulerFor = (sim: RuntimeSim) => {
  let scheduler = schedulers.get(sim);
  if (!scheduler) { scheduler = new AnimationScheduler(); schedulers.set(sim, scheduler); }
  return scheduler;
};

export const useSim = () => {
  const sim = useContext(SimContext);
  if (!sim) throw new Error('useSim must be used inside <SimContext.Provider>');
  return sim;
};

/**
 * Frame callback driven by simulation time, so every animation in the world
 * freezes together when live updates are paused.
 */
export const useSimFrame = (cb: (time: number, dt: number) => void) => {
  const sim = useSim();
  const callback = useRef(cb);
  callback.current = cb;
  useEffect(() => schedulerFor(sim).add((t, dt) => callback.current(t, dt), 30), [sim]);
};

/** Decorative-only animation; it keeps its original time domain but runs at 15Hz. */
export const useDecorativeSimFrame = (cb: (time: number, dt: number) => void) => {
  const sim = useSim();
  const callback = useRef(cb);
  callback.current = cb;
  useEffect(() => schedulerFor(sim).add((t, dt) => callback.current(t, dt), 15), [sim]);
};
