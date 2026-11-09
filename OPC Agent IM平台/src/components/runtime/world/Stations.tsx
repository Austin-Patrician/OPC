import React, { useMemo, useRef } from "react"
import * as THREE from "three"
import { RoundedBox } from "@react-three/drei"
import type { ThreeEvent } from "@react-three/fiber"
import type { WorkerStatus } from "../../../data/runtimeData"
import { useSim, useSimFrame } from "./simContext"
import {
  angleDelta,
  BUILDINGS,
  CAROUSEL_R,
  DECK_Y,
  DOCKS,
  easeInOut,
  ENTRY_ANGLE,
  EXIT_ANGLES,
  glow,
  INGRESS_POS,
  PALETTE,
  ROUTER_OUTER_R,
  ROUTER_POS,
  SEMANTIC,
  STATION_YAW,
  STATIONS,
  STATION_PAD_R,
  StationKind,
  statusColor,
  WATCHDOG_POS,
} from "./worldConfig"
import { HEARTBEAT_PERIOD } from "./runtimeSim"

type Interactive = {
  onSelect?: () => void
  onHover?: (hovering: boolean) => void
}

const handlers = ({ onSelect, onHover }: Interactive) => ({
  onClick: (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    onSelect?.()
  },
  onPointerOver: (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover?.(true)
  },
  onPointerOut: () => onHover?.(false),
})

const Clay = ({ color, rough = 0.82 }: { color: string; rough?: number }) => (
  <meshStandardMaterial color={color} roughness={rough} metalness={0} />
)

/** Emissive material; `level` is the target luminance (≥ 2 blooms). */
const Glow = ({ color, level = 2.4, matRef }: { color: string; level?: number; matRef?: React.Ref<THREE.MeshStandardMaterial> }) => (
  <meshStandardMaterial ref={matRef} color={color} emissive={color} emissiveIntensity={glow(color, level)} roughness={0.4} toneMapped={false} />
)

/** Raised round deck every building stands on. */
function Pad({ radius, color = PALETTE.surface }: { radius: number; color?: string }) {
  return (
    <group>
      <mesh position={[0, DECK_Y / 2, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[radius, radius + 0.05, DECK_Y, 72]} />
        <Clay color={color} />
      </mesh>
      <mesh position={[0, DECK_Y + 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <ringGeometry args={[radius - 0.16, radius - 0.13, 72]} />
        <meshStandardMaterial color={PALETTE.surfaceShade} roughness={0.9} />
      </mesh>
    </group>
  )
}

type RimMode = "breathe" | "blink" | "steady" | "dim"

function StatusRim({ radius, color, mode }: { radius: number; color: string; mode: RimMode }) {
  const mat = useRef<THREE.MeshStandardMaterial>(null!)
  useSimFrame((t) => {
    const k =
      mode === "blink" ? (Math.sin(t * 7.5) > 0 ? 1 : 0.12) : mode === "breathe" ? 0.55 + 0.45 * Math.sin(t * 2.6) : mode === "steady" ? 0.7 : 0.05
    mat.current.emissiveIntensity = glow(color, 0.2 + k * 0.85)
  })
  return (
    <mesh position={[0, DECK_Y + 0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[radius - 0.02, 0.026, 8, 120]} />
      <Glow color={color} matRef={mat} />
    </mesh>
  )
}

/** Ground ring + orbiting ticks that mark the current selection. */
function SelectionHalo({ radius, active, hovered }: { radius: number; active: boolean; hovered: boolean }) {
  const ticks = useRef<THREE.Group>(null!)
  useSimFrame((_, dt) => {
    ticks.current.rotation.y += dt * 0.35
  })
  const visible = active || hovered
  return (
    <group visible={visible}>
      <mesh position={[0, 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[radius + 0.18, radius + 0.24, 120]} />
        <meshBasicMaterial color={active ? PALETTE.graphite : "#8A857D"} transparent opacity={active ? 0.85 : 0.4} />
      </mesh>
      <group ref={ticks} visible={active}>
        {Array.from({ length: 36 }, (_, i) => {
          const a = (i / 36) * Math.PI * 2
          return (
            <mesh key={i} position={[Math.cos(a) * (radius + 0.42), 0.02, Math.sin(a) * (radius + 0.42)]} rotation={[-Math.PI / 2, 0, -a]}>
              <planeGeometry args={[0.04, i % 3 === 0 ? 0.2 : 0.1]} />
              <meshBasicMaterial color={PALETTE.graphite} transparent opacity={0.55} />
            </mesh>
          )
        })}
      </group>
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/* Router: carousel sorter with entry scanner, pointing arm and exit gates    */
/* -------------------------------------------------------------------------- */

export function RouterHub({
  statuses,
  active,
  selected,
  hovered,
  ...interactive
}: { statuses: WorkerStatus[]; active: boolean; selected: boolean; hovered: boolean } & Interactive) {
  const sim = useSim()
  const carousel = useRef<THREE.Group>(null!)
  const arm = useRef<THREE.Group>(null!)
  const halo = useRef<THREE.Mesh>(null!)
  const lens = useRef<THREE.MeshStandardMaterial>(null!)
  const curtain = useRef<THREE.MeshBasicMaterial>(null!)
  const beam = useRef<THREE.MeshBasicMaterial>(null!)
  const armAngle = useRef(ENTRY_ANGLE)

  useSimFrame((t, dt) => {
    carousel.current.rotation.y -= dt * (active ? 0.28 : 0.05)
    halo.current.rotation.z += dt * (active ? 0.9 : 0.15)
    halo.current.position.y = DECK_Y + 1.62 + Math.sin(t * 1.4) * 0.04

    const sorting = sim.parcels.filter((p) => p.active && p.phase === "sort")
    const lead = sorting.sort((a, b) => b.age - a.age)[0]
    let target = ENTRY_ANGLE + Math.sin(t * 0.3) * 0.35
    if (lead) target = ENTRY_ANGLE + angleDelta(ENTRY_ANGLE, EXIT_ANGLES[lead.worker]) * easeInOut(lead.t)
    armAngle.current += angleDelta(armAngle.current, target) * Math.min(1, dt * 7)
    arm.current.rotation.y = -armAngle.current

    const scanning = sim.parcels.some((p) => p.active && p.phase === "sort" && p.age < 0.5)
    curtain.current.opacity = scanning ? 0.22 + Math.sin(t * 40) * 0.05 : 0.05
    beam.current.opacity = lead ? 0.2 : 0.04
    lens.current.emissiveIntensity = glow(SEMANTIC.route, active ? 1.5 + sorting.length * 0.9 + Math.sin(t * 3) * 0.2 : 0.3)
  })

  const exitGates = EXIT_ANGLES.map((a, i) => ({ a, i }))

  return (
    <group position={[ROUTER_POS.x, 0, ROUTER_POS.z]} {...handlers(interactive)}>
      <SelectionHalo radius={2.5} active={selected} hovered={hovered} />
      {/* Paved plaza and plinth */}
      <mesh position={[0, 0.015, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <circleGeometry args={[2.75, 96]} />
        <meshStandardMaterial color={PALETTE.surfaceShade} roughness={0.95} />
      </mesh>
      <mesh position={[0, 0.12, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[2.3, 2.38, 0.24, 96]} />
        <Clay color={PALETTE.surface} />
      </mesh>
      <mesh position={[0, 0.22, 0]}>
        <cylinderGeometry args={[2.31, 2.31, 0.035, 96]} />
        <Clay color={PALETTE.graphite} rough={0.6} />
      </mesh>

      {/* Rotating carousel deck */}
      <group ref={carousel}>
        <mesh position={[0, DECK_Y - 0.07, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[ROUTER_OUTER_R, ROUTER_OUTER_R, 0.14, 96]} />
          <Clay color="#FFFFFF" rough={0.7} />
        </mesh>
        {Array.from({ length: 32 }, (_, i) => {
          const a = (i / 32) * Math.PI * 2
          return (
            <mesh key={i} position={[Math.cos(a) * 1.45, DECK_Y + 0.003, Math.sin(a) * 1.45]} rotation={[-Math.PI / 2, 0, -a]}>
              <planeGeometry args={[0.86, 0.022]} />
              <meshBasicMaterial color="#E4DED5" />
            </mesh>
          )
        })}
      </group>
      <mesh position={[0, DECK_Y + 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[CAROUSEL_R - 0.36, CAROUSEL_R - 0.33, 96]} />
        <meshBasicMaterial color="#D9D3C9" />
      </mesh>

      {/* Central column */}
      <mesh position={[0, DECK_Y + 0.55, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.74, 0.88, 1.1, 64]} />
        <Clay color={PALETTE.surface} />
      </mesh>
      {[0.32, 0.62].map((y) => (
        <mesh key={y} position={[0, DECK_Y + y, 0]}>
          <torusGeometry args={[0.83 - y * 0.12, 0.018, 8, 80]} />
          <Glow color={SEMANTIC.route} level={active ? 1.1 : 0.25} />
        </mesh>
      ))}
      <mesh position={[0, DECK_Y + 1.12, 0]} castShadow>
        <cylinderGeometry args={[0.66, 0.74, 0.06, 64]} />
        <Clay color={PALETTE.graphite} rough={0.55} />
      </mesh>
      <mesh position={[0, DECK_Y + 1.16, 0]}>
        <cylinderGeometry args={[0.46, 0.46, 0.03, 48]} />
        <meshStandardMaterial ref={lens} color={SEMANTIC.route} emissive={SEMANTIC.route} emissiveIntensity={2} toneMapped={false} />
      </mesh>
      <mesh ref={halo} position={[0, DECK_Y + 1.62, 0]} rotation={[Math.PI / 2.4, 0, 0]}>
        <torusGeometry args={[0.42, 0.022, 10, 80]} />
        <Glow color={SEMANTIC.route} level={active ? 2.3 : 0.3} />
      </mesh>

      {/* Sorting arm that tracks the parcel currently on the carousel */}
      <group ref={arm} position={[0, DECK_Y + 0.94, 0]}>
        <mesh position={[1.12, 0, 0]} castShadow>
          <boxGeometry args={[1.0, 0.07, 0.13]} />
          <Clay color={PALETTE.graphite} rough={0.5} />
        </mesh>
        <mesh position={[CAROUSEL_R, -0.1, 0]} castShadow>
          <boxGeometry args={[0.22, 0.16, 0.22]} />
          <Clay color={PALETTE.surface} />
        </mesh>
        <mesh position={[CAROUSEL_R, -0.19, 0]}>
          <boxGeometry args={[0.15, 0.02, 0.15]} />
          <Glow color={SEMANTIC.route} level={2.6} />
        </mesh>
        <mesh position={[CAROUSEL_R, -0.48, 0]}>
          <coneGeometry args={[0.32, 0.58, 24, 1, true]} />
          <meshBasicMaterial ref={beam} color={SEMANTIC.routeSoft} transparent opacity={0.12} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {/* Entry scanner arch */}
      <group rotation={[0, -ENTRY_ANGLE, 0]}>
        {[0.98, 1.92].map((r) => (
          <mesh key={r} position={[r, DECK_Y + 0.42, 0]} castShadow>
            <boxGeometry args={[0.08, 0.84, 0.16]} />
            <Clay color={PALETTE.graphite} rough={0.5} />
          </mesh>
        ))}
        <mesh position={[1.45, DECK_Y + 0.86, 0]} castShadow>
          <boxGeometry args={[1.06, 0.08, 0.2]} />
          <Clay color={PALETTE.graphite} rough={0.5} />
        </mesh>
        <mesh position={[1.45, DECK_Y + 0.42, 0]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[0.02, 0.8]} />
          <meshBasicMaterial color={SEMANTIC.route} transparent opacity={0.6} />
        </mesh>
        <mesh position={[1.45, DECK_Y + 0.42, 0]} rotation={[0, 0, 0]}>
          <planeGeometry args={[0.86, 0.8]} />
          <meshBasicMaterial ref={curtain} color={SEMANTIC.routeSoft} transparent opacity={0.08} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>

      {/* Exit gates, one per workshop, carrying that workshop's identity color */}
      {exitGates.map(({ a, i }) => (
        <group key={i} rotation={[0, -a, 0]}>
          {[-0.32, 0.32].map((z) => (
            <mesh key={z} position={[2.12, DECK_Y + 0.2, z]} castShadow>
              <boxGeometry args={[0.07, 0.42, 0.07]} />
              <Clay color={PALETTE.surfaceShade} />
            </mesh>
          ))}
          <mesh position={[2.12, DECK_Y + 0.43, 0]} castShadow>
            <boxGeometry args={[0.1, 0.07, 0.74]} />
            <Clay color={STATIONS[i].accent} rough={0.6} />
          </mesh>
          <mesh position={[2.12, DECK_Y + 0.5, 0]}>
            <sphereGeometry args={[0.045, 12, 10]} />
            <Glow color={statusColor(statuses[i])} level={statuses[i] === "Idle" ? 0.35 : 2.6} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/* Ingress portal                                                             */
/* -------------------------------------------------------------------------- */

export function IngressGate({ active, ...interactive }: { active: boolean } & Interactive) {
  const sim = useSim()
  const membrane = useRef<THREE.MeshBasicMaterial>(null!)
  const ring = useRef<THREE.MeshStandardMaterial>(null!)
  useSimFrame((t) => {
    const emitting = sim.parcels.some((p) => p.active && p.phase === "ingress" && p.t < 0.25)
    membrane.current.opacity = active ? (emitting ? 0.42 : 0.16 + Math.sin(t * 2) * 0.04) : 0.05
    ring.current.emissiveIntensity = glow(SEMANTIC.route, active ? (emitting ? 2.8 : 1.1) : 0.2)
  })
  return (
    <group position={[INGRESS_POS.x, 0, INGRESS_POS.z]} {...handlers(interactive)}>
      <Pad radius={1.35} />
      <group position={[0.15, DECK_Y, 0]} rotation={[0, Math.PI / 2, 0]}>
        <mesh castShadow>
          <torusGeometry args={[0.78, 0.12, 20, 64, Math.PI]} />
          <Clay color={PALETTE.surface} />
        </mesh>
        <mesh position={[0, 0, 0.13]}>
          <torusGeometry args={[0.78, 0.022, 10, 64, Math.PI]} />
          <meshStandardMaterial ref={ring} color={SEMANTIC.route} emissive={SEMANTIC.route} emissiveIntensity={2} toneMapped={false} />
        </mesh>
        <mesh>
          <circleGeometry args={[0.66, 48, 0, Math.PI]} />
          <meshBasicMaterial ref={membrane} color={SEMANTIC.routeSoft} transparent opacity={0.18} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
        </mesh>
      </group>
      {/* Waiting stack of parcels behind the portal */}
      {[
        [-0.62, 0.17, -0.42, 0.2],
        [-0.72, 0.17, 0.3, -0.25],
        [-0.68, 0.5, -0.1, 0.5],
      ].map(([x, y, z, r], i) => (
        <group key={i} position={[x, DECK_Y + y, z]} rotation={[0, r, 0]}>
          <RoundedBox args={[0.42, 0.33, 0.42]} radius={0.03} castShadow>
            <Clay color={i === 2 ? PALETTE.kraftDark : PALETTE.kraft} rough={0.9} />
          </RoundedBox>
          <mesh position={[0, 0.168, 0]}>
            <boxGeometry args={[0.08, 0.01, 0.43]} />
            <Clay color={PALETTE.tape} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/* Worker workshops                                                           */
/* -------------------------------------------------------------------------- */

function Observatory({ index, accent }: { index: number; accent: string }) {
  const sim = useSim()
  const head = useRef<THREE.Group>(null!)
  const lens = useRef<THREE.MeshStandardMaterial>(null!)
  useSimFrame((t, dt) => {
    const working = sim.isWorking(index)
    head.current.rotation.y += dt * (working ? 1.1 : 0.12)
    lens.current.emissiveIntensity = glow(accent, working ? 2.3 + Math.sin(t * 6) * 0.3 : 0.35)
  })
  return (
    <group>
      <RoundedBox args={[1.25, 0.1, 1.25]} radius={0.04} position={[0, 0.05, 0]} castShadow receiveShadow>
        <Clay color={PALETTE.surfaceShade} />
      </RoundedBox>
      <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.58, 0.62, 0.66, 48]} />
        <Clay color={PALETTE.surface} />
      </mesh>
      <mesh position={[0, 0.76, 0]}>
        <cylinderGeometry args={[0.6, 0.6, 0.05, 48]} />
        <Clay color={PALETTE.graphite} rough={0.5} />
      </mesh>
      <group ref={head} position={[0, 0.78, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[0.57, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <Clay color={accent} rough={0.6} />
        </mesh>
        <mesh position={[0, 0.32, 0.33]} rotation={[-0.65, 0, 0]}>
          <boxGeometry args={[0.16, 0.5, 0.05]} />
          <Clay color={PALETTE.graphite} rough={0.4} />
        </mesh>
        <group position={[0, 0.3, 0.12]} rotation={[-0.75, 0, 0]}>
          <mesh position={[0, 0.4, 0]} castShadow>
            <cylinderGeometry args={[0.07, 0.1, 0.72, 20]} />
            <Clay color={PALETTE.surface} />
          </mesh>
          <mesh position={[0, 0.77, 0]}>
            <cylinderGeometry args={[0.075, 0.075, 0.02, 20]} />
            <meshStandardMaterial ref={lens} color={accent} emissive={accent} emissiveIntensity={1} toneMapped={false} />
          </mesh>
        </group>
      </group>
    </group>
  )
}

function Gear({ radius, color, teeth = 10 }: { radius: number; color: string; teeth?: number }) {
  return (
    <group>
      <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[radius, radius, 0.08, 32]} />
        <Clay color={color} rough={0.55} />
      </mesh>
      {Array.from({ length: teeth }, (_, i) => {
        const a = (i / teeth) * Math.PI * 2
        return (
          <mesh key={i} position={[Math.cos(a) * (radius + 0.04), Math.sin(a) * (radius + 0.04), 0]} rotation={[0, 0, a]} castShadow>
            <boxGeometry args={[0.1, 0.08, 0.08]} />
            <Clay color={color} rough={0.55} />
          </mesh>
        )
      })}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, 0, 0.045]}>
        <cylinderGeometry args={[radius * 0.32, radius * 0.32, 0.02, 20]} />
        <Clay color={PALETTE.graphite} rough={0.4} />
      </mesh>
    </group>
  )
}

function Forge({ index, accent }: { index: number; accent: string }) {
  const sim = useSim()
  const gearA = useRef<THREE.Group>(null!)
  const gearB = useRef<THREE.Group>(null!)
  const smoke = useRef<THREE.Group>(null!)
  const glass = useRef<THREE.MeshStandardMaterial>(null!)
  useSimFrame((t, dt) => {
    const working = sim.isWorking(index)
    const speed = working ? 2.4 : 0.15
    gearA.current.rotation.z += dt * speed
    gearB.current.rotation.z -= dt * speed * 1.6
    glass.current.emissiveIntensity = glow("#F2A541", working ? 1.4 + Math.sin(t * 9) * 0.2 : 0.15)
    smoke.current.children.forEach((puff, i) => {
      const phase = (t * 0.55 + i / 3) % 1
      puff.position.set(Math.sin(phase * 4 + i) * 0.05, phase * 0.9, 0)
      puff.scale.setScalar(working ? 0.08 + phase * 0.16 : 0.0001)
      ;((puff as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = (1 - phase) * 0.85
    })
  })
  return (
    <group>
      <RoundedBox args={[1.2, 0.62, 0.92]} radius={0.08} smoothness={4} position={[0, 0.31, 0]} castShadow receiveShadow>
        <Clay color={PALETTE.surface} />
      </RoundedBox>
      <RoundedBox args={[0.64, 0.46, 0.64]} radius={0.07} smoothness={4} position={[-0.22, 0.85, -0.1]} castShadow receiveShadow>
        <Clay color={accent} rough={0.65} />
      </RoundedBox>
      <mesh position={[0.36, 0.98, -0.22]} castShadow>
        <cylinderGeometry args={[0.09, 0.11, 0.72, 20]} />
        <Clay color={PALETTE.graphite} rough={0.5} />
      </mesh>
      <group ref={smoke} position={[0.36, 1.36, -0.22]}>
        {[0, 1, 2].map((i) => (
          <mesh key={i}>
            <sphereGeometry args={[1, 16, 12]} />
            <meshStandardMaterial color="#FFFFFF" roughness={1} transparent opacity={0.8} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <mesh position={[-0.28, 0.3, 0.462]}>
        <planeGeometry args={[0.42, 0.22]} />
        <meshStandardMaterial ref={glass} color="#F6C784" emissive="#F2A541" emissiveIntensity={1} toneMapped={false} />
      </mesh>
      <group ref={gearA} position={[0.28, 0.34, 0.5]}>
        <Gear radius={0.2} color={accent} />
      </group>
      <group ref={gearB} position={[0.5, 0.56, 0.5]} scale={0.55}>
        <Gear radius={0.2} color={PALETTE.graphite} teeth={8} />
      </group>
    </group>
  )
}

function Studio({ index, accent }: { index: number; accent: string }) {
  const sim = useSim()
  const orbit = useRef<THREE.Group>(null!)
  const slit = useRef<THREE.MeshStandardMaterial>(null!)
  useSimFrame((t, dt) => {
    const working = sim.isWorking(index)
    orbit.current.rotation.y += dt * (working ? 1.5 : 0.18)
    orbit.current.children.forEach((card, i) => {
      card.position.y = 0.9 + Math.sin(t * 2.2 + i * 1.6) * (working ? 0.1 : 0.03)
    })
    slit.current.emissiveIntensity = glow(accent, working ? 2.2 : 0.3)
  })
  return (
    <group>
      <RoundedBox args={[0.62, 1.46, 0.62]} radius={0.08} smoothness={4} position={[0, 0.73, 0]} castShadow receiveShadow>
        <Clay color={PALETTE.surface} />
      </RoundedBox>
      <RoundedBox args={[0.74, 0.14, 0.74]} radius={0.05} position={[0, 1.52, 0]} castShadow>
        <Clay color={accent} rough={0.6} />
      </RoundedBox>
      <mesh position={[0, 0.78, 0.316]}>
        <planeGeometry args={[0.05, 0.9]} />
        <meshStandardMaterial ref={slit} color={accent} emissive={accent} emissiveIntensity={1} toneMapped={false} />
      </mesh>
      <group ref={orbit}>
        {[0, 1, 2, 3].map((i) => {
          const a = (i / 4) * Math.PI * 2
          return (
            <group key={i} position={[Math.cos(a) * 0.74, 0.9, Math.sin(a) * 0.74]} rotation={[0, -a + Math.PI / 2, 0.08]}>
              <RoundedBox args={[0.3, 0.38, 0.025]} radius={0.01} castShadow>
                <Clay color="#FFFFFF" rough={0.6} />
              </RoundedBox>
              <mesh position={[0, 0.1, 0.014]}>
                <planeGeometry args={[0.2, 0.035]} />
                <meshBasicMaterial color={accent} />
              </mesh>
              <mesh position={[-0.02, 0.02, 0.014]}>
                <planeGeometry args={[0.16, 0.022]} />
                <meshBasicMaterial color="#D8D2C8" />
              </mesh>
              <mesh position={[-0.04, -0.04, 0.014]}>
                <planeGeometry args={[0.12, 0.022]} />
                <meshBasicMaterial color="#D8D2C8" />
              </mesh>
            </group>
          )
        })}
      </group>
    </group>
  )
}

function Silos({ index, accent }: { index: number; accent: string }) {
  const sim = useSim()
  const bars = useRef<THREE.Group>(null!)
  useSimFrame((t) => {
    const working = sim.isWorking(index)
    bars.current.children.forEach((bar, i) => {
      const h = working ? 0.25 + 0.75 * Math.abs(Math.sin(t * 5 + i * 0.9)) : 0.12
      bar.scale.y = h
      bar.position.y = 0.04 + h * 0.2
    })
  })
  const silos: [number, number, number, number, string][] = [
    [-0.32, -0.18, 1.0, 0.27, PALETTE.surface],
    [0.26, -0.26, 1.34, 0.28, accent],
    [-0.02, 0.32, 0.76, 0.25, PALETTE.surface],
  ]
  return (
    <group>
      {silos.map(([x, z, h, r, color], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
            <cylinderGeometry args={[r, r, h, 36]} />
            <Clay color={color} rough={0.7} />
          </mesh>
          <mesh position={[0, h, 0]} castShadow>
            <sphereGeometry args={[r, 36, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <Clay color={color === accent ? PALETTE.surface : accent} rough={0.65} />
          </mesh>
          <mesh position={[0, h * 0.62, 0]}>
            <cylinderGeometry args={[r + 0.005, r + 0.005, 0.03, 36]} />
            <Clay color={PALETTE.graphite} rough={0.5} />
          </mesh>
        </group>
      ))}
      <group ref={bars} position={[0.18, 0, 0.52]}>
        {[0, 1, 2, 3, 4].map((i) => (
          <mesh key={i} position={[i * 0.11 - 0.22, 0.1, 0]}>
            <boxGeometry args={[0.07, 0.4, 0.07]} />
            <Glow color={accent} level={0.9} />
          </mesh>
        ))}
      </group>
    </group>
  )
}

function InspectionGate({ index, accent, failed }: { index: number; accent: string; failed: boolean }) {
  const sim = useSim()
  const bar = useRef<THREE.Mesh>(null!)
  const barMat = useRef<THREE.MeshStandardMaterial>(null!)
  const curtain = useRef<THREE.MeshBasicMaterial>(null!)
  useSimFrame((t) => {
    const working = sim.isWorking(index)
    const scanning = working || failed
    bar.current.visible = scanning
    bar.current.position.y = 0.2 + (Math.sin(t * (failed ? 9 : 3)) * 0.5 + 0.5) * 0.9
    barMat.current.emissiveIntensity = glow(failed ? SEMANTIC.fail : SEMANTIC.route, failed ? (Math.sin(t * 14) > 0 ? 3 : 0.4) : 2.4)
    curtain.current.opacity = scanning ? 0.1 : 0
  })
  const scanColor = failed ? SEMANTIC.fail : SEMANTIC.route
  return (
    <group>
      {[-0.5, 0.5].map((x) => (
        <RoundedBox key={x} args={[0.24, 1.3, 0.26]} radius={0.05} position={[x, 0.65, 0]} castShadow receiveShadow>
          <Clay color={PALETTE.surface} />
        </RoundedBox>
      ))}
      <RoundedBox args={[1.38, 0.2, 0.36]} radius={0.05} position={[0, 1.37, 0]} castShadow>
        <Clay color={accent} rough={0.6} />
      </RoundedBox>
      <mesh ref={bar} position={[0, 0.6, 0]}>
        <boxGeometry args={[0.76, 0.035, 0.06]} />
        <meshStandardMaterial ref={barMat} color={scanColor} emissive={scanColor} emissiveIntensity={3} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.65, 0]}>
        <planeGeometry args={[0.76, 1.2]} />
        <meshBasicMaterial ref={curtain} color={scanColor} transparent opacity={0.1} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
      </mesh>
      <RoundedBox args={[0.46, 0.52, 0.46]} radius={0.06} position={[0.98, 0.26, -0.4]} castShadow receiveShadow>
        <Clay color={PALETTE.surface} />
      </RoundedBox>
      <mesh position={[0.98, 0.58, -0.4]} castShadow>
        <coneGeometry args={[0.36, 0.22, 4]} />
        <Clay color={accent} rough={0.6} />
      </mesh>
    </group>
  )
}

/** Floating status glyph: amber hourglass for waiting, red alert crystal for failed. */
function StatusGlyph({ status }: { status: WorkerStatus }) {
  const ref = useRef<THREE.Group>(null!)
  useSimFrame((t, dt) => {
    if (!ref.current) return
    ref.current.rotation.y += dt * 1.2
    ref.current.position.y = 2.15 + Math.sin(t * 2) * 0.07
  })
  if (status !== "Waiting" && status !== "Failed") return null
  const color = status === "Waiting" ? SEMANTIC.wait : SEMANTIC.fail
  return (
    <group ref={ref} position={[0, 2.15, 0]}>
      {status === "Waiting" ? (
        <>
          <mesh position={[0, 0.1, 0]}>
            <coneGeometry args={[0.12, 0.2, 20]} />
            <Glow color={color} level={1.6} />
          </mesh>
          <mesh position={[0, -0.1, 0]} rotation={[Math.PI, 0, 0]}>
            <coneGeometry args={[0.12, 0.2, 20]} />
            <Glow color={color} level={1.6} />
          </mesh>
        </>
      ) : (
        <mesh>
          <octahedronGeometry args={[0.17, 0]} />
          <Glow color={color} level={2.4} />
        </mesh>
      )}
    </group>
  )
}

function Dock({ index }: { index: number }) {
  const sim = useSim()
  const mat = useRef<THREE.MeshStandardMaterial>(null!)
  useSimFrame((t) => {
    const p = sim.parcels.find((q) => q.active && q.worker === index && (q.phase === "unbox" || q.phase === "absorb" || q.phase === "fault" || q.phase === "hold"))
    const tint = !p ? 0 : p.phase === "hold" ? 0.6 + Math.sin(t * 3) * 0.4 : 1
    const hue = p?.phase === "fault" ? SEMANTIC.fail : p?.phase === "hold" ? SEMANTIC.wait : "#F2B35B"
    mat.current.emissive.set(hue)
    mat.current.emissiveIntensity = glow(hue, tint * 0.45)
  })
  const d = DOCKS[index]
  return (
    <group position={[d.x, DECK_Y, d.z]} rotation={[0, STATION_YAW[index], 0]}>
      <RoundedBox args={[0.82, 0.03, 0.82]} radius={0.012} position={[0, 0.012, 0]} receiveShadow>
        <meshStandardMaterial ref={mat} color="#ECE6DC" roughness={0.8} emissive="#F2B35B" emissiveIntensity={0} />
      </RoundedBox>
      {[
        [-0.36, -0.36],
        [0.36, -0.36],
        [-0.36, 0.36],
        [0.36, 0.36],
      ].map(([x, z], i) => (
        <mesh key={i} position={[x, 0.032, z]} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.1, 0.1]} />
          <meshBasicMaterial color={PALETTE.graphite} transparent opacity={0.35} />
        </mesh>
      ))}
    </group>
  )
}

const BUILDING: Record<StationKind, React.FC<{ index: number; accent: string; failed: boolean }>> = {
  research: Observatory,
  code: Forge,
  content: Studio,
  data: Silos,
  review: InspectionGate,
}

export function WorkerStation({
  index,
  status,
  selected,
  hovered,
  ...interactive
}: { index: number; status: WorkerStatus; selected: boolean; hovered: boolean } & Interactive) {
  const spec = STATIONS[index]
  const Building = BUILDING[spec.kind]
  const b = BUILDINGS[index]
  const rimMode: RimMode = status === "Running" ? "breathe" : status === "Failed" ? "blink" : status === "Waiting" ? "steady" : "dim"
  const local = useMemo(() => new THREE.Vector3(b.x - spec.pos.x, 0, b.z - spec.pos.z), [b, spec])
  return (
    <group {...handlers(interactive)}>
      <group position={[spec.pos.x, 0, spec.pos.z]}>
        <SelectionHalo radius={STATION_PAD_R} active={selected} hovered={hovered} />
        <Pad radius={STATION_PAD_R} />
        <StatusRim radius={STATION_PAD_R} color={statusColor(status)} mode={rimMode} />
        <group position={[local.x, DECK_Y, local.z]} rotation={[0, STATION_YAW[index], 0]}>
          <Building index={index} accent={spec.accent} failed={status === "Failed"} />
        </group>
        <group position={[local.x, DECK_Y, local.z]}>
          <StatusGlyph status={status} />
        </group>
      </group>
      <Dock index={index} />
    </group>
  )
}

/* -------------------------------------------------------------------------- */
/* Watchdog lighthouse                                                        */
/* -------------------------------------------------------------------------- */

export function WatchdogTower({
  stale,
  selected,
  hovered,
  ...interactive
}: { stale: boolean; selected: boolean; hovered: boolean } & Interactive) {
  const sim = useSim()
  const beam = useRef<THREE.Group>(null!)
  const beamMat = useRef<THREE.MeshBasicMaterial>(null!)
  const core = useRef<THREE.MeshStandardMaterial>(null!)
  const ripples = useRef<THREE.Group>(null!)
  const color = stale ? SEMANTIC.fail : SEMANTIC.ok

  useSimFrame((t, dt) => {
    beam.current.rotation.y += dt * (stale ? 0 : 0.7)
    const sinceReport = t - sim.lastReportAt
    const flash = sinceReport < 0.6 ? 1 - sinceReport / 0.6 : 0
    if (stale) {
      const blink = Math.sin(t * 6) > 0 ? 1 : 0.15
      core.current.emissiveIntensity = glow(color, 0.3 + blink * 2.4)
      beamMat.current.opacity = 0.03 + blink * 0.05
    } else {
      core.current.emissiveIntensity = glow(color, 2.1 + flash * 2.2 + Math.sin(t * 5.2) * 0.2)
      beamMat.current.opacity = 0.07 + flash * 0.06
    }
    ripples.current.children.forEach((ring, i) => {
      const mesh = ring as THREE.Mesh
      const mat = mesh.material as THREE.MeshBasicMaterial
      if (stale) {
        mesh.scale.setScalar(1.25)
        mat.opacity = i === 0 ? (Math.sin(t * 6) > 0 ? 0.55 : 0.1) : 0
        return
      }
      const phase = ((t - sim.lastBeat) / (HEARTBEAT_PERIOD * 2) + i / 3 + 1) % 1
      mesh.scale.setScalar(1 + phase * 1.35)
      mat.opacity = (1 - phase) * 0.45
    })
  })

  return (
    <group position={[WATCHDOG_POS.x, 0, WATCHDOG_POS.z]} {...handlers(interactive)}>
      <SelectionHalo radius={1.45} active={selected} hovered={hovered} />
      <group ref={ripples} position={[0, 0.02, 0]}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[1.42, 1.48, 96]} />
            <meshBasicMaterial color={color} transparent opacity={0.4} depthWrite={false} />
          </mesh>
        ))}
      </group>
      <Pad radius={1.4} />
      <StatusRim radius={1.4} color={color} mode={stale ? "blink" : "breathe"} />
      <group position={[0, DECK_Y, 0]}>
        <mesh position={[0, 1.38, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.24, 0.44, 2.76, 40]} />
          <Clay color={PALETTE.surface} />
        </mesh>
        {[0.85, 1.75].map((y) => (
          <mesh key={y} position={[0, y, 0]}>
            <cylinderGeometry args={[0.44 - y * 0.073 + 0.012, 0.44 - y * 0.073 + 0.02, 0.16, 40]} />
            <Clay color={PALETTE.graphite} rough={0.5} />
          </mesh>
        ))}
        <mesh position={[0, 2.78, 0]} castShadow>
          <cylinderGeometry args={[0.44, 0.44, 0.06, 40]} />
          <Clay color={PALETTE.graphite} rough={0.5} />
        </mesh>
        <mesh position={[0, 3.0, 0]}>
          <cylinderGeometry args={[0.25, 0.25, 0.38, 32, 1, true]} />
          <meshStandardMaterial color="#FFFFFF" transparent opacity={0.28} roughness={0.1} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, 3.0, 0]}>
          <sphereGeometry args={[0.13, 24, 16]} />
          <meshStandardMaterial ref={core} color={color} emissive={color} emissiveIntensity={3} toneMapped={false} />
        </mesh>
        <mesh position={[0, 3.36, 0]} castShadow>
          <coneGeometry args={[0.34, 0.36, 32]} />
          <Clay color={PALETTE.graphite} rough={0.5} />
        </mesh>
        <mesh position={[0, 3.66, 0]}>
          <cylinderGeometry args={[0.012, 0.012, 0.3, 6]} />
          <Clay color={PALETTE.graphite} />
        </mesh>
        <mesh position={[0, 3.83, 0]}>
          <sphereGeometry args={[0.04, 12, 10]} />
          <Glow color={color} level={2.6} />
        </mesh>
        <group ref={beam} position={[0, 3.0, 0]}>
          <group rotation={[0, 0, -0.16]}>
            <mesh position={[2.1, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
              <coneGeometry args={[0.75, 4.2, 32, 1, true]} />
              <meshBasicMaterial ref={beamMat} color={color} transparent opacity={0.08} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} />
            </mesh>
          </group>
        </group>
      </group>
    </group>
  )
}
