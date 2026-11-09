import { createContext, useContext, useEffect, useRef } from "react"
import { useFrame } from "@react-three/fiber"
import type { RuntimeSim } from "./runtimeSim"

export const SimContext = createContext<RuntimeSim | null>(null)

type Callback = (time: number, dt: number) => void
class AnimationScheduler {
  private callbacks = new Set<Callback>()
  add(cb: Callback) { this.callbacks.add(cb); return () => this.callbacks.delete(cb) }
  tick(time: number, dt: number) { this.callbacks.forEach((cb) => cb(time, dt)) }
}
const schedulers = new WeakMap<RuntimeSim, AnimationScheduler>()
export const schedulerFor = (sim: RuntimeSim) => {
  let scheduler = schedulers.get(sim)
  if (!scheduler) { scheduler = new AnimationScheduler(); schedulers.set(sim, scheduler) }
  return scheduler
}

export const useSim = () => {
  const sim = useContext(SimContext)
  if (!sim) throw new Error("useSim must be used inside <SimContext.Provider>")
  return sim
}

/**
 * Frame callback driven by simulation time, so every animation in the world
 * freezes together when live updates are paused.
 */
export const useSimFrame = (cb: (time: number, dt: number) => void) => {
  const sim = useSim()
  const callback = useRef(cb)
  callback.current = cb
  useEffect(() => schedulerFor(sim).add((t, dt) => callback.current(t, dt)), [sim])
}
