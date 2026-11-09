import React, { useMemo, useRef } from "react"
import * as THREE from "three"
import { useSim, useSimFrame } from "./simContext"
import type { RuntimeSim } from "./runtimeSim"
import type { LabelAnchor } from "./labelBridge"
import {
  angleDelta,
  BUILDINGS,
  carouselPoint,
  clamp01,
  DECK_Y,
  DOCKS,
  easeInOut,
  easeOut,
  ENTRY_ANGLE,
  EXIT_ANGLES,
  glow,
  INGRESS_CURVE,
  PALETTE,
  PARCEL_Y,
  RETURN_CURVES,
  SEMANTIC,
  STATION_YAW,
  STATIONS,
  TRANSIT_CURVES,
} from "./worldConfig"

const tmp = new THREE.Vector3()
const tan = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)
const NEUTRAL_STRIPE = new THREE.Color("#E6D7BE")
const FAULT = new THREE.Color(SEMANTIC.fail)
const ACCENTS = STATIONS.map((s) => new THREE.Color(s.accent))

const WALLS: { p: [number, number, number]; s: [number, number, number] }[] = [
  { p: [0, 0, 0.235], s: [0.5, 0.4, 0.03] },
  { p: [0, 0, -0.235], s: [0.5, 0.4, 0.03] },
  { p: [0.235, 0, 0], s: [0.03, 0.4, 0.44] },
  { p: [-0.235, 0, 0], s: [0.03, 0.4, 0.44] },
]

/** Sine ease that keeps parcels from snapping at the ends of a rail. */
const glide = (t: number) => t - Math.sin(2 * Math.PI * t) / (2 * Math.PI)

function ParcelUnit({ slot }: { slot: number }) {
  const sim = useSim()
  const box = useRef<THREE.Group>(null!)
  const flapL = useRef<THREE.Group>(null!)
  const flapR = useRef<THREE.Group>(null!)
  const stripeA = useRef<THREE.MeshStandardMaterial>(null!)
  const stripeB = useRef<THREE.MeshStandardMaterial>(null!)
  const core = useRef<THREE.Group>(null!)
  const coreMat = useRef<THREE.MeshStandardMaterial>(null!)
  const coreHalo = useRef<THREE.MeshBasicMaterial>(null!)
  const holdRing = useRef<THREE.Mesh>(null!)
  const holdMat = useRef<THREE.MeshBasicMaterial>(null!)

  useSimFrame((t) => {
    const p = sim.parcels[slot]
    if (!p.active) {
      box.current.visible = false
      core.current.visible = false
      holdRing.current.visible = false
      return
    }

    box.current.visible = true
    holdRing.current.visible = false
    let scale = 1
    let squash = 1
    let yaw = 0
    let flap = 0
    let tilt = 0
    let coreVisible = false
    let coreScale = 0
    let coreGlow = 0
    const accent = ACCENTS[p.worker]
    let stripe: THREE.Color = NEUTRAL_STRIPE
    let coreColor: THREE.Color = accent
    let coreHex = STATIONS[p.worker].accent

    switch (p.phase) {
      case "ingress": {
        INGRESS_CURVE.getPointAt(glide(p.t), tmp)
        tmp.y += Math.abs(Math.sin(p.t * Math.PI * 6)) * 0.035
        scale = easeOut(clamp01(p.t / 0.14))
        yaw = Math.PI / 2
        break
      }
      case "sort": {
        const a = ENTRY_ANGLE + angleDelta(ENTRY_ANGLE, EXIT_ANGLES[p.worker]) * easeInOut(p.t)
        tmp.copy(carouselPoint(a))
        tmp.y += Math.sin(p.t * Math.PI) * 0.06
        yaw = -a + Math.PI / 2
        // The label is printed while the parcel passes the entry scanner.
        if (p.t > 0.28) stripe = accent
        break
      }
      case "transit": {
        const curve = TRANSIT_CURVES[p.worker]
        const u = glide(p.t)
        curve.getPointAt(u, tmp)
        curve.getTangentAt(u, tan)
        tmp.y += Math.abs(Math.sin(u * Math.PI * 11)) * 0.03
        yaw = Math.atan2(tan.x, tan.z)
        stripe = accent
        break
      }
      case "hold": {
        tmp.set(DOCKS[p.worker].x, PARCEL_Y, DOCKS[p.worker].z)
        yaw = STATION_YAW[p.worker]
        stripe = accent
        flap = 0.12 + Math.sin(t * 2.4) * 0.08
        holdRing.current.visible = true
        holdRing.current.position.set(tmp.x, DECK_Y + 0.04, tmp.z)
        const pulse = (t * 0.8) % 1
        holdRing.current.scale.setScalar(1 + pulse * 0.6)
        holdMat.current.opacity = (1 - pulse) * 0.9
        break
      }
      case "unbox": {
        tmp.set(DOCKS[p.worker].x, PARCEL_Y, DOCKS[p.worker].z)
        yaw = STATION_YAW[p.worker]
        stripe = accent
        flap = easeOut(clamp01(p.t / 0.42)) * 2.15
        squash = 1 - Math.sin(clamp01(p.t / 0.22) * Math.PI) * 0.08
        const rise = easeOut(clamp01((p.t - 0.18) / 0.82))
        coreVisible = true
        coreScale = rise
        coreGlow = rise
        core.current.position.set(tmp.x, PARCEL_Y + 0.05 + rise * 0.78, tmp.z)
        break
      }
      case "absorb": {
        const dock = DOCKS[p.worker]
        tmp.set(dock.x, PARCEL_Y, dock.z)
        yaw = STATION_YAW[p.worker]
        stripe = accent
        flap = 2.15
        scale = 1 - easeInOut(p.t)
        tmp.y -= p.t * 0.18
        const target = BUILDINGS[p.worker]
        const k = easeInOut(p.t)
        coreVisible = true
        coreScale = 1 - k * 0.75
        coreGlow = 1 + k
        core.current.position.set(
          THREE.MathUtils.lerp(dock.x, target.x, k),
          THREE.MathUtils.lerp(PARCEL_Y + 0.83, DECK_Y + 1.25, k) + Math.sin(k * Math.PI) * 0.45,
          THREE.MathUtils.lerp(dock.z, target.z, k),
        )
        break
      }
      case "fault": {
        tmp.set(DOCKS[p.worker].x, PARCEL_Y, DOCKS[p.worker].z)
        yaw = STATION_YAW[p.worker]
        stripe = accent
        flap = 2.15
        tilt = Math.sin(t * 38) * 0.06 * (1 - p.t)
        const fade = p.t > 0.75 ? 1 - (p.t - 0.75) / 0.25 : 1
        scale = fade
        coreVisible = true
        coreColor = FAULT
        coreHex = SEMANTIC.fail
        coreScale = fade * (0.9 + Math.sin(t * 20) * 0.1)
        coreGlow = 1.4
        core.current.position.set(tmp.x + Math.sin(t * 45) * 0.03, PARCEL_Y + 0.62, tmp.z)
        break
      }
    }

    box.current.position.copy(tmp)
    box.current.rotation.set(tilt, yaw, tilt * 0.6)
    box.current.scale.set(scale, scale * squash, scale)
    flapL.current.rotation.z = flap
    flapR.current.rotation.z = -flap
    stripeA.current.color.copy(stripe)
    stripeB.current.color.copy(stripe)

    core.current.visible = coreVisible
    if (coreVisible) {
      core.current.scale.setScalar(Math.max(0.0001, coreScale))
      core.current.rotation.y = t * 2.4
      core.current.rotation.x = t * 1.3
      coreMat.current.color.copy(coreColor)
      coreMat.current.emissive.copy(coreColor)
      coreMat.current.emissiveIntensity = glow(coreHex, 1.2 + coreGlow * 1.4)
      coreHalo.current.color.copy(coreColor)
      coreHalo.current.opacity = 0.14 + coreGlow * 0.12
    }
  })

  const kraft = PALETTE.kraft
  return (
    <group>
      <group ref={box} visible={false}>
        {/* Open-top carton: base + four walls so the interior shows when flaps lift */}
        <mesh position={[0, -0.185, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.5, 0.03, 0.5]} />
          <meshStandardMaterial color={PALETTE.kraftDark} roughness={0.9} />
        </mesh>
        {WALLS.map((w, i) => (
          <mesh key={i} position={w.p} castShadow receiveShadow>
            <boxGeometry args={w.s} />
            <meshStandardMaterial color={kraft} roughness={0.92} />
          </mesh>
        ))}
        {/* Destination stripe + shipping label printed by the Router scanner */}
        <mesh position={[0, 0.07, 0.252]}>
          <boxGeometry args={[0.3, 0.07, 0.006]} />
          <meshStandardMaterial ref={stripeA} color="#E6D7BE" roughness={0.6} />
        </mesh>
        <mesh position={[0, 0.07, -0.252]}>
          <boxGeometry args={[0.3, 0.07, 0.006]} />
          <meshStandardMaterial ref={stripeB} color="#E6D7BE" roughness={0.6} />
        </mesh>
        <mesh position={[-0.06, -0.06, 0.252]}>
          <boxGeometry args={[0.18, 0.1, 0.006]} />
          <meshStandardMaterial color="#FBF8F2" roughness={0.7} />
        </mesh>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[-0.11 + i * 0.03, -0.06, 0.256]}>
            <boxGeometry args={[0.012, 0.07, 0.002]} />
            <meshBasicMaterial color={PALETTE.graphite} />
          </mesh>
        ))}
        {/* Hinged lid flaps with tape along the seam */}
        <group ref={flapL} position={[-0.25, 0.2, 0]}>
          <mesh position={[0.125, 0.012, 0]} castShadow>
            <boxGeometry args={[0.25, 0.024, 0.5]} />
            <meshStandardMaterial color="#DDB689" roughness={0.9} />
          </mesh>
          <mesh position={[0.226, 0.026, 0]}>
            <boxGeometry args={[0.048, 0.006, 0.5]} />
            <meshStandardMaterial color={PALETTE.tape} roughness={0.5} />
          </mesh>
        </group>
        <group ref={flapR} position={[0.25, 0.2, 0]}>
          <mesh position={[-0.125, 0.012, 0]} castShadow>
            <boxGeometry args={[0.25, 0.024, 0.5]} />
            <meshStandardMaterial color="#DDB689" roughness={0.9} />
          </mesh>
          <mesh position={[-0.226, 0.026, 0]}>
            <boxGeometry args={[0.048, 0.006, 0.5]} />
            <meshStandardMaterial color={PALETTE.tape} roughness={0.5} />
          </mesh>
        </group>
      </group>

      {/* The task core that rises out of an opened parcel and flies into the workshop */}
      <group ref={core} visible={false}>
        <mesh>
          <icosahedronGeometry args={[0.15, 0]} />
          <meshStandardMaterial ref={coreMat} color={SEMANTIC.route} emissive={SEMANTIC.route} emissiveIntensity={3} flatShading toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.32, 20, 16]} />
          <meshBasicMaterial ref={coreHalo} color={SEMANTIC.route} transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      <mesh ref={holdRing} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.44, 0.5, 48]} />
        <meshBasicMaterial ref={holdMat} color={SEMANTIC.wait} transparent opacity={0.8} depthWrite={false} />
      </mesh>
    </group>
  )
}

/** Glowing report capsule that travels from a workshop to the Watchdog. */
function CapsuleUnit({ slot }: { slot: number }) {
  const sim = useSim()
  const group = useRef<THREE.Group>(null!)
  const body = useRef<THREE.Mesh>(null!)
  const mat = useRef<THREE.MeshStandardMaterial>(null!)
  const trail = useRef<THREE.Group>(null!)
  const q = useMemo(() => new THREE.Quaternion(), [])
  const ok = useMemo(() => new THREE.Color(SEMANTIC.ok), [])
  const fail = useMemo(() => new THREE.Color(SEMANTIC.fail), [])

  useSimFrame((t) => {
    const c = sim.capsules[slot]
    group.current.visible = c.active
    if (!c.active) return
    const curve = RETURN_CURVES[c.worker]
    const u = easeInOut(c.t)
    curve.getPointAt(u, tmp)
    curve.getTangentAt(u, tan)
    body.current.position.set(tmp.x, tmp.y + Math.sin(t * 6 + slot) * 0.03, tmp.z)
    q.setFromUnitVectors(UP, tan)
    body.current.quaternion.copy(q)
    const color = c.failed ? fail : ok
    mat.current.color.copy(color)
    mat.current.emissive.copy(color)
    mat.current.emissiveIntensity = glow(c.failed ? SEMANTIC.fail : SEMANTIC.ok, 2.4)
    const fadeIn = clamp01(c.t / 0.08)
    body.current.scale.setScalar(fadeIn)
    trail.current.children.forEach((dot, i) => {
      const back = Math.max(0, u - (i + 1) * 0.022)
      curve.getPointAt(back, tmp)
      dot.position.copy(tmp)
      dot.scale.setScalar(fadeIn * (1 - i * 0.22))
      const m = (dot as THREE.Mesh).material as THREE.MeshBasicMaterial
      m.color.copy(color)
    })
  })

  return (
    <group ref={group} visible={false}>
      <mesh ref={body} castShadow>
        <capsuleGeometry args={[0.075, 0.2, 6, 14]} />
        <meshStandardMaterial ref={mat} color={SEMANTIC.ok} emissive={SEMANTIC.ok} emissiveIntensity={3.2} toneMapped={false} />
      </mesh>
      <group ref={trail}>
        {[0, 1, 2, 3].map((i) => (
          <mesh key={i}>
            <sphereGeometry args={[0.045, 10, 8]} />
            <meshBasicMaterial color={SEMANTIC.ok} transparent opacity={0.45 - i * 0.09} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

const TAG_ORDER = ["transit", "unbox", "absorb", "hold", "fault"]

/**
 * Anchor for the floating event tag that follows the most relevant parcel bound for
 * the focused workshop (or any workshop), e.g. "dispatch.task · research-042".
 * The element is expected to contain a dot span followed by a text span.
 */
export const parcelTagAnchor = (sim: RuntimeSim, focus: { current: number }): LabelAnchor => {
  let shown = ""
  return (out, el) => {
    const f = focus.current
    // Skip ingress/sort so the tag never sits on top of the Router's own label.
    const candidates = sim.parcels.filter((p) => p.active && (f < 0 || p.worker === f) && p.phase !== "ingress" && p.phase !== "sort")
    const p = candidates.sort((a, b) => TAG_ORDER.indexOf(a.phase) - TAG_ORDER.indexOf(b.phase) || a.t - b.t)[0]
    if (!p) return false

    if (p.phase === "transit") TRANSIT_CURVES[p.worker].getPointAt(glide(p.t), out)
    else if (p.phase === "sort") out.copy(carouselPoint(ENTRY_ANGLE + angleDelta(ENTRY_ANGLE, EXIT_ANGLES[p.worker]) * easeInOut(p.t)))
    else out.set(DOCKS[p.worker].x, PARCEL_Y, DOCKS[p.worker].z)
    out.y += 0.64

    const verb =
      p.phase === "sort" ? "route.scan" : p.phase === "transit" ? "dispatch.task" : p.phase === "hold" ? "await.upstream" : p.phase === "fault" ? "unbox.fault" : "unbox.task"
    const text = `${verb} · ${p.corr}`
    if (shown !== text) {
      shown = text
      const dot = el.firstElementChild as HTMLElement | null
      const label = el.lastElementChild as HTMLElement | null
      if (label) label.textContent = text
      if (dot)
        dot.style.background =
          p.phase === "fault" ? SEMANTIC.fail : p.phase === "hold" ? SEMANTIC.wait : p.phase === "transit" || p.phase === "sort" ? SEMANTIC.route : SEMANTIC.ok
    }
    return true
  }
}

export function ParcelLayer() {
  const sim = useSim()
  return (
    <group>
      {sim.parcels.map((_, i) => (
        <ParcelUnit key={i} slot={i} />
      ))}
      {sim.capsules.map((_, i) => (
        <CapsuleUnit key={i} slot={i} />
      ))}
    </group>
  )
}
