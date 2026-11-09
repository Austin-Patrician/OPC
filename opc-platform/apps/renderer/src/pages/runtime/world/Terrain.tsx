import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBox } from '@react-three/drei';
import { PALETTE } from './worldConfig';
import { useDecorativeSimFrame } from './simContext';

/** Typographic marking painted onto the plinth, drawn into a canvas texture (no font fetch). */
function GroundMark({
  index,
  title,
  position,
  width = 3.2,
}: {
  index: string;
  title: string;
  position: [number, number, number];
  width?: number;
}) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '10px';
    ctx.font = '500 60px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.fillText(index, 8, 66);
    const w = ctx.measureText(index).width;
    ctx.fillRect(w + 30, 64, 72, 4);
    ctx.font = '600 60px "JetBrains Mono", ui-monospace, Menlo, monospace';
    ctx.fillText(title, w + 132, 66);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }, [index, title]);
  return (
    <mesh position={[position[0], 0.008, position[2]]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[width, width / 8]} />
      <meshBasicMaterial
        map={texture}
        color="#7D7468"
        transparent
        opacity={0.9}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Soft shadow pooled beneath the floating plinth. */
function DropShadow() {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
    g.addColorStop(0, 'rgba(60,45,30,0.55)');
    g.addColorStop(0.55, 'rgba(60,45,30,0.22)');
    g.addColorStop(1, 'rgba(60,45,30,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    return new THREE.CanvasTexture(canvas);
  }, []);
  return (
    <mesh position={[1.2, -3.6, 2.4]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[44, 32]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} opacity={0.5} />
    </mesh>
  );
}

const riverX = (z: number) => -0.95 + Math.sin(z * 0.34 + 0.6) * 0.42;
const RIVER_WIDTH = 1.55;

function riverShape(widthPad: number) {
  const shape = new THREE.Shape();
  const zs: number[] = [];
  for (let z = -9.35; z <= 9.35; z += 0.35) zs.push(z);
  // Shape lives in XY; the mesh is rotated so shape-y maps to world -z.
  zs.forEach((z, i) => {
    const x = riverX(z) - widthPad;
    if (i === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  [...zs].reverse().forEach((z) => shape.lineTo(riverX(z) + RIVER_WIDTH + widthPad, -z));
  shape.closePath();
  return shape;
}

function River() {
  const bank = useMemo(() => new THREE.ShapeGeometry(riverShape(0.16)), []);
  const water = useMemo(() => new THREE.ShapeGeometry(riverShape(0)), []);
  const streaks = useRef<THREE.Group>(null!);
  const seeds = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => ({
        z: -9 + i * 2.1,
        lane: (i % 3) * 0.45 + 0.35,
        len: 0.5 + (i % 4) * 0.18,
      })),
    [],
  );

  useDecorativeSimFrame((t) => {
    streaks.current.children.forEach((child, i) => {
      const s = seeds[i]!;
      const z = ((s.z + t * 0.55 + 9.4) % 18.8) - 9.4;
      child.position.set(riverX(z) + s.lane, 0.022, z);
      const edge = Math.min(1, (9.4 - Math.abs(z)) / 1.2);
      ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.55 * edge;
    });
  });

  return (
    <group>
      <mesh geometry={bank} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} receiveShadow>
        <meshStandardMaterial color={PALETTE.waterLight} roughness={0.9} />
      </mesh>
      <mesh geometry={water} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
        <meshStandardMaterial color={PALETTE.water} roughness={0.25} metalness={0.05} />
      </mesh>
      <group ref={streaks}>
        {seeds.map((s, i) => (
          <mesh key={i} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.035, s.len]} />
            <meshBasicMaterial color="#FFFFFF" transparent opacity={0.5} depthWrite={false} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

const TREES: { p: [number, number, number]; s: number; tone: number; round?: boolean }[] = [
  { p: [-12.6, 0, -7.6], s: 1.15, tone: 0 },
  { p: [-11.7, 0, -8.3], s: 0.85, tone: 1, round: true },
  { p: [-13.2, 0, -6.4], s: 0.75, tone: 2 },
  { p: [-12.8, 0, 7.1], s: 1.05, tone: 1 },
  { p: [-11.6, 0, 8.0], s: 0.8, tone: 0, round: true },
  { p: [-7.6, 0, -8.4], s: 0.9, tone: 2, round: true },
  { p: [-6.6, 0, -8.7], s: 1.1, tone: 0 },
  { p: [-7.2, 0, 8.3], s: 1.0, tone: 0 },
  { p: [-6.1, 0, 8.6], s: 0.75, tone: 2, round: true },
  { p: [1.0, 0, -8.8], s: 0.95, tone: 1 },
  { p: [1.9, 0, -9.0], s: 0.7, tone: 2, round: true },
  { p: [1.4, 0, 8.9], s: 1.0, tone: 0 },
  { p: [8.0, 0, -7.9], s: 1.05, tone: 2 },
  { p: [8.9, 0, -8.6], s: 0.8, tone: 0, round: true },
  { p: [8.3, 0, 7.9], s: 0.95, tone: 1, round: true },
  { p: [13.0, 0, -5.4], s: 1.1, tone: 0 },
  { p: [13.3, 0, -4.2], s: 0.7, tone: 1, round: true },
  { p: [13.1, 0, 5.2], s: 1.0, tone: 2 },
  { p: [12.5, 0, 6.5], s: 0.8, tone: 0, round: true },
];

function TreeBatch({ tone, kind }: { tone: number; kind: 'trunk' | 'coneLower' | 'coneUpper' | 'round' }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const instances = useMemo(() => TREES.flatMap((tree) => {
    if (kind === 'trunk') return [{ position: new THREE.Vector3(tree.p[0], tree.p[1] + 0.18 * tree.s, tree.p[2]), scale: new THREE.Vector3(tree.s, tree.s, tree.s) }];
    const round = kind === 'round';
    const cone = kind === 'coneLower' || kind === 'coneUpper';
    if (tree.tone !== tone || Boolean(tree.round) !== round) return [];
    if (cone && tree.round) return [];
    const heights = kind === 'round' ? [0.62] : kind === 'coneLower' ? [0.58] : kind === 'coneUpper' ? [0.9] : [];
    return heights.map((height) => ({ position: new THREE.Vector3(tree.p[0], tree.p[1] + height * tree.s, tree.p[2]), scale: new THREE.Vector3(tree.s, tree.s, tree.s) }));
  }), [kind, tone]);
  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    instances.forEach(({ position, scale }, index) => {
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [instances]);
  if (!instances.length) return null;
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, instances.length]} castShadow>
      {kind === 'trunk' ? <cylinderGeometry args={[0.05, 0.07, 0.36, 6]} /> : kind === 'coneLower' ? <coneGeometry args={[0.36, 0.62, 7]} /> : kind === 'coneUpper' ? <coneGeometry args={[0.26, 0.46, 7]} /> : <icosahedronGeometry args={[0.36, 0]} />}
      <meshStandardMaterial color={kind === 'trunk' ? PALETTE.trunk : PALETTE.foliage[tone % PALETTE.foliage.length]} roughness={0.9} flatShading={kind !== 'trunk'} />
    </instancedMesh>
  );
}

const ROCKS: { p: [number, number, number]; s: number; r: number }[] = [
  { p: [-9.4, 0.08, -3.2], s: 0.22, r: 0.4 },
  { p: [-8.9, 0.06, 3.6], s: 0.16, r: 1.2 },
  { p: [0.9, 0.07, -5.9], s: 0.2, r: 2.1 },
  { p: [-0.2, 0.06, 6.4], s: 0.17, r: 0.8 },
  { p: [8.2, 0.07, -2.4], s: 0.19, r: 1.7 },
  { p: [8.6, 0.06, 2.8], s: 0.15, r: 0.2 },
];

/** Floating diorama plinth with river, trees and rocks. */
export function Terrain() {
  return (
    <group>
      <DropShadow />
      <RoundedBox
        args={[29.5, 1.1, 20.2]}
        radius={0.5}
        smoothness={5}
        position={[0, -0.55, 0]}
        receiveShadow
      >
        <meshStandardMaterial color={PALETTE.ground} roughness={0.95} />
      </RoundedBox>
      <RoundedBox args={[28.9, 1.2, 19.6]} radius={0.55} smoothness={5} position={[0, -1.5, 0]}>
        <meshStandardMaterial color={PALETTE.groundSide} roughness={1} />
      </RoundedBox>
      <RoundedBox args={[28.1, 0.9, 18.8]} radius={0.5} smoothness={4} position={[0, -2.35, 0]}>
        <meshStandardMaterial color={PALETTE.groundDeep} roughness={1} />
      </RoundedBox>

      <River />

      <GroundMark index="01" title="INGRESS" position={[-10.6, 0, 2.3]} width={3.6} />
      <GroundMark index="02" title="ROUTER" position={[-4.6, 0, 3.7]} width={3.6} />
      <GroundMark index="03" title="WORKERS" position={[6.4, 0, 9.0]} width={3.6} />
      <GroundMark index="04" title="WATCHDOG" position={[10.8, 0, 2.75]} width={3.6} />

      <TreeBatch tone={-1} kind="trunk" />
      {PALETTE.foliage.map((_, tone) => <TreeBatch key={`cone-low-${tone}`} tone={tone} kind="coneLower" />)}
      {PALETTE.foliage.map((_, tone) => <TreeBatch key={`cone-high-${tone}`} tone={tone} kind="coneUpper" />)}
      {PALETTE.foliage.map((_, tone) => <TreeBatch key={`round-${tone}`} tone={tone} kind="round" />)}
      {ROCKS.map((r, i) => (
        <mesh
          key={i}
          position={r.p}
          rotation={[r.r, r.r * 1.7, 0]}
          scale={[r.s * 1.4, r.s, r.s * 1.1]}
          castShadow
          receiveShadow
        >
          <dodecahedronGeometry args={[1, 0]} />
          <meshStandardMaterial color={PALETTE.rock} roughness={0.95} flatShading />
        </mesh>
      ))}
    </group>
  );
}
