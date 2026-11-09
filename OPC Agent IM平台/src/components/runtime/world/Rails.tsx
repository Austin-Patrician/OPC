import React, { useMemo, useRef } from "react"
import * as THREE from "three"
import { Line } from "@react-three/drei"
import type { WorkerStatus } from "../../../data/runtimeData"
import { useSimFrame } from "./simContext"
import {
  INGRESS_RAIL,
  PALETTE,
  RAIL_Y,
  RETURN_CURVES,
  SEMANTIC,
  TRANSIT_RAILS,
} from "./worldConfig"

type Line2Like = { material: { dashOffset: number } }

/** A flattened tube that reads as a monorail deck, held up by slim posts. */
function Rail({
  curve,
  flowColor,
  emphasis,
  flowSpeed,
  dim,
}: {
  curve: THREE.Curve<THREE.Vector3>
  flowColor: string
  emphasis: boolean
  flowSpeed: number
  dim: boolean
}) {
  const deck = useMemo(() => {
    const g = new THREE.TubeGeometry(curve, 96, 0.17, 12, false)
    g.translate(0, -RAIL_Y, 0)
    g.scale(1, 0.3, 1)
    return g
  }, [curve])

  const posts = useMemo(() => {
    const length = curve.getLength()
    const count = Math.max(1, Math.floor(length / 1.05))
    const pts: THREE.Vector3[] = []
    for (let i = 1; i < count; i++) pts.push(curve.getPointAt(i / count))
    return pts
  }, [curve])

  const flowPoints = useMemo(
    () => curve.getSpacedPoints(120).map((p) => new THREE.Vector3(p.x, p.y + 0.056, p.z)),
    [curve],
  )

  const lineRef = useRef<Line2Like>(null)
  useSimFrame((_, dt) => {
    if (lineRef.current) lineRef.current.material.dashOffset -= dt * flowSpeed
  })

  return (
    <group>
      <mesh geometry={deck} position={[0, RAIL_Y, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={emphasis ? "#FFFFFF" : PALETTE.surface} roughness={0.7} />
      </mesh>
      {posts.map((p, i) => (
        <mesh key={i} position={[p.x, (RAIL_Y - 0.05) / 2, p.z]} castShadow>
          <cylinderGeometry args={[0.045, 0.06, RAIL_Y - 0.05, 8]} />
          <meshStandardMaterial color={PALETTE.surfaceShade} roughness={0.8} />
        </mesh>
      ))}
      <Line
        ref={lineRef as never}
        points={flowPoints}
        color={flowColor}
        lineWidth={emphasis ? 2.6 : 1.6}
        dashed
        dashSize={0.32}
        gapSize={0.22}
        transparent
        opacity={dim ? 0.25 : emphasis ? 1 : 0.75}
      />
    </group>
  )
}

/** Dotted telemetry lane from each workshop to the Watchdog. */
function ReportLane({ curve, color, emphasis }: { curve: THREE.Curve<THREE.Vector3>; color: string; emphasis: boolean }) {
  const points = useMemo(() => {
    const n = Math.floor(curve.getLength() / 0.34)
    return Array.from({ length: n }, (_, i) => curve.getPointAt((i + 0.5) / n))
  }, [curve])

  const setRef = (mesh: THREE.InstancedMesh | null) => {
    if (!mesh) return
    const m = new THREE.Matrix4()
    points.forEach((p, i) => {
      m.makeTranslation(p.x, 0.035, p.z)
      mesh.setMatrixAt(i, m)
    })
    mesh.instanceMatrix.needsUpdate = true
  }

  return (
    <instancedMesh ref={setRef} args={[undefined, undefined, points.length]} receiveShadow>
      <sphereGeometry args={[emphasis ? 0.05 : 0.038, 10, 8]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </instancedMesh>
  )
}

export function Rails({
  statuses,
  selectedIndex,
  empty,
  stale,
}: {
  statuses: WorkerStatus[]
  selectedIndex: number
  empty: boolean
  stale: boolean
}) {
  return (
    <group>
      <Rail curve={INGRESS_RAIL} flowColor={SEMANTIC.route} emphasis={false} flowSpeed={0.9} dim={empty} />
      {TRANSIT_RAILS.map((curve, i) => {
        const s = statuses[i]
        const flowColor = s === "Failed" ? SEMANTIC.fail : s === "Waiting" ? SEMANTIC.wait : s === "Idle" ? SEMANTIC.idle : SEMANTIC.route
        return (
          <Rail
            key={i}
            curve={curve}
            flowColor={flowColor}
            emphasis={selectedIndex === i}
            flowSpeed={s === "Running" ? 0.9 : s === "Waiting" ? 0.25 : s === "Failed" ? 0.5 : 0}
            dim={empty || s === "Idle"}
          />
        )
      })}
      {RETURN_CURVES.map((curve, i) => (
        <ReportLane
          key={i}
          curve={curve}
          emphasis={selectedIndex === i}
          color={stale ? "#EBB4AE" : statuses[i] === "Failed" ? "#E9B1AA" : statuses[i] === "Idle" ? "#D6D1CA" : SEMANTIC.okSoft}
        />
      ))}
    </group>
  )
}
