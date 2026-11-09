import React, { memo, useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import { Bloom, EffectComposer, N8AO, ToneMapping, Vignette } from "@react-three/postprocessing"
import { ToneMappingMode } from "postprocessing"
import type { RuntimePrototypeVariant, WorkerStatus } from "../../../data/runtimeData"
import { RuntimeSim, SimStats } from "./runtimeSim"
import { SimContext, schedulerFor, useSim } from "./simContext"
import { qualityOverride, RUNTIME_QUALITY, RuntimeQualityController, RuntimeQualityTier } from "./runtimeQuality"
import { Terrain } from "./Terrain"
import { Rails } from "./Rails"
import { IngressGate, RouterHub, WatchdogTower, WorkerStation } from "./Stations"
import { ParcelLayer, parcelTagAnchor } from "./Parcels"
import type { LabelBridge } from "./labelBridge"
import {
  BUILDINGS,
  INGRESS_POS,
  ROUTER_POS,
  STATION_PAD_R,
  STATIONS,
  WATCHDOG_POS,
} from "./worldConfig"

export type WorldSelection = "router" | "watchdog" | string | null

interface RuntimeWorldProps {
  sim: RuntimeSim
  labels: LabelBridge
  statuses: WorkerStatus[]
  variant: RuntimePrototypeVariant
  paused: boolean
  selection: WorldSelection
  onSelect: (selection: WorldSelection) => void
  onIngress: () => void
  onBackground: () => void
  onStats: (stats: SimStats) => void
}

const BG = "#F2EEE7"
// Viewed from the south so the pipeline reads left (ingress) → right (watchdog).
const LOOK_AT = new THREE.Vector3(0.3, 0, 1.7)
const VIEW_DIR = new THREE.Vector3(0.16, 0.8, 0.58).normalize()
const BASE_AZIMUTH = Math.atan2(VIEW_DIR.x, VIEW_DIR.z)

type OrbitLike = { target: THREE.Vector3; update: () => void }

/** `?nofx` disables post-processing (useful on software GL or for profiling). */
const PARAMS = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search)
const POST_FX = !PARAMS.has("nofx")
const AMBIENT_OCCLUSION = !PARAMS.has("noao")
/** `?snap` keeps the drawing buffer so headless screenshots capture the canvas. */
const SNAPSHOT = PARAMS.has("snap")

function SimDriver({ paused, onStats }: { paused: boolean; onStats: (s: SimStats) => void }) {
  const sim = useSim()
  const acc = useRef(0)
  const animAcc = useRef(0)
  useFrame((_, delta) => {
    // Business simulation is fixed at 30Hz while rendering remains display-rate.
    if (!paused) {
      acc.current += Math.min(delta, 0.1)
      while (acc.current >= 1 / 30) { sim.update(1 / 30); acc.current -= 1 / 30 }
    }
    animAcc.current += delta
    if (animAcc.current >= 1 / 30) {
      const dt = animAcc.current
      animAcc.current = 0
      schedulerFor(sim).tick(sim.time, dt)
    }
    acc.current += delta
    if (acc.current > 0.35) {
      acc.current = 0
      onStats(sim.stats())
    }
  })
  return null
}

/** Frames the diorama for the current aspect ratio and eases the orbit target toward the focus. */
function CameraRig({ focus }: { focus: THREE.Vector3 | null }) {
  const camera = useThree((s) => s.camera)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  const controls = useThree((s) => s.controls) as unknown as OrbitLike | null
  const desired = useMemo(() => new THREE.Vector3(), [])

  useEffect(() => {
    const aspect = width / Math.max(1, height)
    // Fit the 30-unit-wide plinth horizontally, with room for the HUD around it.
    const distance = 47 * THREE.MathUtils.clamp(1.5 / aspect, 0.92, 1.7)
    camera.position.copy(VIEW_DIR).multiplyScalar(distance).add(LOOK_AT)
    camera.lookAt(LOOK_AT)
    camera.updateProjectionMatrix()
  }, [camera, width, height])

  useFrame((_, delta) => {
    if (!controls) return
    desired.copy(LOOK_AT)
    if (focus) {
      desired.lerp(focus, 0.32)
      // The inspector covers the right edge, so slide the world left while it is open.
      desired.x += 3.4
    }
    // Frame-rate independent easing (≈90% of the way in ~0.8s).
    controls.target.lerp(desired, 1 - Math.exp(-Math.min(delta, 0.1) * 2.9))
    controls.update()
  })
  return null
}

const projected = new THREE.Vector3()

/** Projects every registered label anchor to screen space and moves its DOM element. */
function LabelProjector({ labels }: { labels: LabelBridge }) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const elapsed = useRef(0)
  const last = useRef({ x: new Map<string, number>(), y: new Map<string, number>(), opacity: new Map<string, string>() })
  useFrame((_, delta) => {
    elapsed.current += delta
    if (elapsed.current < 1 / 10) return
    elapsed.current = 0
    labels.anchors.forEach((anchor, id) => {
      const el = labels.elements.get(id)
      if (!el) return
      if (!anchor(projected, el)) {
        if (last.current.opacity.get(id) !== "0") { el.style.opacity = "0"; last.current.opacity.set(id, "0") }
        return
      }
      projected.project(camera)
      const visible = projected.z < 1 && Math.abs(projected.x) < 1.15 && Math.abs(projected.y) < 1.15
      const x = (projected.x * 0.5 + 0.5) * size.width
      const y = (-projected.y * 0.5 + 0.5) * size.height
      const shift = el.dataset.align === "start" ? "translate(0, -50%)" : "translate(-50%, -50%)"
      const px = last.current.x.get(id)
      const py = last.current.y.get(id)
      const opacity = visible ? "1" : "0"
      if (px === undefined || py === undefined || Math.abs(px - x) > 0.25 || Math.abs(py - y) > 0.25) {
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) ${shift}`
        last.current.x.set(id, x); last.current.y.set(id, y)
      }
      if (last.current.opacity.get(id) !== opacity) { el.style.opacity = opacity; last.current.opacity.set(id, opacity) }
    })
  })
  return null
}

function Scene({ sim, labels, statuses, variant, paused, selection, onSelect, onIngress, onStats, quality, setQuality }: Omit<RuntimeWorldProps, "onBackground"> & { quality: RuntimeQualityTier; setQuality: (tier: RuntimeQualityTier) => void }) {
  const fpsWindow = useRef({ elapsed: 0, frames: 0 })
  const controller = useRef(new RuntimeQualityController(quality))
  const override = qualityOverride()
  useFrame((_, delta) => {
    if (override) return
    fpsWindow.current.elapsed += delta
    fpsWindow.current.frames += 1
    if (fpsWindow.current.elapsed >= 1) {
      const tier = controller.current.sample(fpsWindow.current.frames / fpsWindow.current.elapsed, performance.now())
      setQuality(tier)
      fpsWindow.current = { elapsed: 0, frames: 0 }
    }
  })
  const [hovered, setHovered] = useState<string | null>(null)
  const empty = variant === "empty"
  const stale = variant === "stale"
  const selectedIndex = STATIONS.findIndex((s) => s.workerId === selection)
  const focusRef = useRef(selectedIndex)
  focusRef.current = selectedIndex

  useEffect(() => {
    const fixed = (x: number, y: number, z: number) => (out: THREE.Vector3) => {
      out.set(x, y, z)
      return true
    }
    labels.anchors.set("ingress", fixed(INGRESS_POS.x, 1.95, INGRESS_POS.z))
    labels.anchors.set("router", fixed(ROUTER_POS.x, 2.75, ROUTER_POS.z))
    labels.anchors.set("watchdog", fixed(WATCHDOG_POS.x, 4.75, WATCHDOG_POS.z))
    // Workshop labels sit beside each pad (callout style) so they never cover a neighbour.
    STATIONS.forEach((s, i) => labels.anchors.set(s.workerId, fixed(s.pos.x + STATION_PAD_R + 0.25, 0.9, s.pos.z)))
    labels.anchors.set("tag", parcelTagAnchor(sim, focusRef))
    return () => labels.anchors.clear()
  }, [labels, sim])

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : ""
    return () => {
      document.body.style.cursor = ""
    }
  }, [hovered])

  const hover = (id: string) => (on: boolean) => setHovered((h) => (on ? id : h === id ? null : h))

  const focus = useMemo(() => {
    if (selection === "router") return ROUTER_POS
    if (selection === "watchdog") return WATCHDOG_POS
    if (selectedIndex >= 0) return BUILDINGS[selectedIndex]
    return null
  }, [selection, selectedIndex])

  return (
    <>
      <SimDriver paused={paused} onStats={onStats} />
      <CameraRig focus={focus} />

      <hemisphereLight args={["#FFFFFF", "#E2D9CA", 1.15]} />
      <directionalLight
        position={[9, 20, 11]}
        intensity={2.1}
        color="#FFF3E2"
        castShadow={quality !== "low"}
        shadow-mapSize={[RUNTIME_QUALITY[quality].shadowMapSize, RUNTIME_QUALITY[quality].shadowMapSize]}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={1}
        shadow-camera-far={60}
        shadow-bias={-0.00025}
        shadow-normalBias={0.03}
      />
      <directionalLight position={[-12, 8, -6]} intensity={0.55} color="#E3EBFF" />

      <Terrain />
      <Rails statuses={statuses} selectedIndex={selectedIndex} empty={empty} stale={stale} />

      <IngressGate active={!empty} onSelect={onIngress} onHover={hover("ingress")} />
      <RouterHub
        statuses={statuses}
        active={!empty}
        selected={selection === "router"}
        hovered={hovered === "router"}
        onSelect={() => onSelect("router")}
        onHover={hover("router")}
      />
      {STATIONS.map((s, i) => (
        <WorkerStation
          key={s.workerId}
          index={i}
          status={statuses[i]}
          selected={selection === s.workerId}
          hovered={hovered === s.workerId}
          onSelect={() => onSelect(s.workerId)}
          onHover={hover(s.workerId)}
        />
      ))}
      <WatchdogTower
        stale={stale}
        selected={selection === "watchdog"}
        hovered={hovered === "watchdog"}
        onSelect={() => onSelect("watchdog")}
        onHover={hover("watchdog")}
      />
      <ParcelLayer />
      <LabelProjector labels={labels} />

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        rotateSpeed={0.45}
        zoomSpeed={0.6}
        minDistance={20}
        maxDistance={72}
        minPolarAngle={0.32}
        maxPolarAngle={1.08}
        minAzimuthAngle={BASE_AZIMUTH - 0.7}
        maxAzimuthAngle={BASE_AZIMUTH + 0.7}
      />

      {RUNTIME_QUALITY[quality].bloom && POST_FX && (
        <EffectComposer multisampling={RUNTIME_QUALITY[quality].multisampling} enableNormalPass={false}>
          {/* Full-resolution AO: n8ao's half-res path relies on a render-target API removed in three r16x+. */}
          {RUNTIME_QUALITY[quality].ao && AMBIENT_OCCLUSION ? <N8AO aoRadius={0.9} distanceFalloff={0.55} intensity={2.4} quality="medium" color="#3A2C1E" /> : <></>}
          <Bloom mipmapBlur luminanceThreshold={3.3} luminanceSmoothing={0.6} intensity={0.85} radius={0.7} />
          <ToneMapping mode={ToneMappingMode.NEUTRAL} />
          <Vignette offset={0.32} darkness={0.32} />
        </EffectComposer>
      )}
    </>
  )
}

export const RuntimeWorld = memo(function RuntimeWorld({ onBackground, ...rest }: RuntimeWorldProps) {
  const [quality, setQuality] = useState<RuntimeQualityTier>(() => qualityOverride() ?? "balanced")
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const config = RUNTIME_QUALITY[quality]
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden")
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return (
    <Canvas
      frameloop={visible ? "always" : "never"}
      shadows={config.shadows ? "percentage" : false}
      dpr={config.dpr}
      camera={{ fov: 28, near: 0.5, far: 160, position: [16, 19, 18] }}
      gl={{ antialias: !POST_FX, powerPreference: "high-performance", toneMapping: THREE.NeutralToneMapping, preserveDrawingBuffer: SNAPSHOT }}
      onPointerMissed={onBackground}
    >
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 60, 120]} />
      <SimContext.Provider value={rest.sim}>
        <Scene {...rest} quality={quality} setQuality={setQuality} />
      </SimContext.Provider>
    </Canvas>
  )
})
