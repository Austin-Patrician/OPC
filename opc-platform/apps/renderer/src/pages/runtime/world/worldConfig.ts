import * as THREE from 'three';
import type { WorkerStatus } from '../../../data/runtimeData';

/** Surface heights (world units). Rails, carousel and docks share one deck height. */
export const DECK_Y = 0.37;
export const PARCEL_Y = DECK_Y + 0.21;
export const RAIL_Y = 0.32;

export const PALETTE = {
  ground: '#EEEAE3',
  groundSide: '#E3DDD3',
  groundDeep: '#D6CFC3',
  surface: '#FAF8F5',
  surfaceShade: '#EFEBE5',
  graphite: '#2A2E35',
  kraft: '#D2A877',
  kraftDark: '#B98B5A',
  tape: '#EFE2C6',
  water: '#C5DFEA',
  waterLight: '#E2F0F5',
  foliage: ['#A9C79B', '#8FB884', '#B9D3A8'],
  trunk: '#A88A6C',
  rock: '#D4CCBF',
};

/** Semantic colors: green = healthy, amber = waiting, red = failed/stale, blue = routing. */
export const SEMANTIC = {
  route: '#3E6BF0',
  routeSoft: '#8FA8F7',
  ok: '#1E9E5A',
  okSoft: '#8ACFA6',
  wait: '#D99A1E',
  fail: '#DC4A3D',
  idle: '#A8A29E',
};

export const statusColor = (s: WorkerStatus) =>
  s === 'Running'
    ? SEMANTIC.ok
    : s === 'Waiting'
      ? SEMANTIC.wait
      : s === 'Completed'
        ? SEMANTIC.okSoft
      : s === 'Failed'
        ? SEMANTIC.fail
        : SEMANTIC.idle;

const lumCache = new Map<string, number>();
/** Relative luminance of a color in linear space (three converts sRGB hex on construction). */
export const luminance = (hex: string) => {
  let v = lumCache.get(hex);
  if (v === undefined) {
    const c = new THREE.Color(hex);
    v = Math.max(0.04, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
    lumCache.set(hex, v);
  }
  return v;
};

/**
 * Emissive intensity that lands a color at a target luminance. Levels below ~1.8
 * read as colored light; levels above cross the bloom threshold and glow.
 */
/** Scene lighting is high-key, so emissive levels are scaled into the same exposure range. */
export const EXPOSURE = 1.8;
export const glow = (hex: string, level: number) => (level * EXPOSURE) / luminance(hex);

export type StationKind = 'research' | 'code' | 'content' | 'data' | 'review';

export interface StationSpec {
  workerId: string;
  threadId?: string;
  kind: StationKind;
  label: string;
  cnRole: string;
  accent: string;
  pos: THREE.Vector3;
}

const DEFAULT_STATIONS: StationSpec[] = [
  {
    workerId: 'worker-research',
    kind: 'research',
    label: 'Research',
    cnRole: '探索检索',
    accent: '#7F8FF4',
    pos: new THREE.Vector3(2.9, 0, -7.0),
  },
  {
    workerId: 'worker-code',
    kind: 'code',
    label: 'Code',
    cnRole: '代码构建',
    accent: '#48B5A6',
    pos: new THREE.Vector3(4.6, 0, -3.5),
  },
  {
    workerId: 'worker-content',
    kind: 'content',
    label: 'Content',
    cnRole: '内容生成',
    accent: '#E9A07A',
    pos: new THREE.Vector3(5.3, 0, 0),
  },
  {
    workerId: 'worker-data',
    kind: 'data',
    label: 'Data',
    cnRole: '数据整理',
    accent: '#A58FEA',
    pos: new THREE.Vector3(4.6, 0, 3.5),
  },
  {
    workerId: 'worker-review',
    kind: 'review',
    label: 'Review',
    cnRole: '质检把关',
    accent: '#BCA77E',
    pos: new THREE.Vector3(2.9, 0, 7.0),
  },
];

/** The live scene replaces this list whenever the backend worker roster changes. */
export let STATIONS: StationSpec[] = DEFAULT_STATIONS;

export const STATION_PAD_R = 1.5;

export const INGRESS_POS = new THREE.Vector3(-10.4, 0, 0);
export const ROUTER_POS = new THREE.Vector3(-4.4, 0, 0);
export const WATCHDOG_POS = new THREE.Vector3(10.6, 0, 0);

/** Carousel geometry of the Router sorter. */
export const CAROUSEL_R = 1.45;
export const ROUTER_OUTER_R = 1.95;

const flat = (v: THREE.Vector3) => new THREE.Vector3(v.x, 0, v.z);

/** Angle (around +y, measured in the xz plane) from the Router to each station. */
export let EXIT_ANGLES = STATIONS.map((s) =>
  Math.atan2(s.pos.z - ROUTER_POS.z, s.pos.x - ROUTER_POS.x),
);
export const ENTRY_ANGLE = Math.PI;

export const carouselPoint = (angle: number, radius = CAROUSEL_R, y = PARCEL_Y) =>
  new THREE.Vector3(
    ROUTER_POS.x + Math.cos(angle) * radius,
    y,
    ROUTER_POS.z + Math.sin(angle) * radius,
  );

/** Where parcels land in front of each workshop (facing the Router). */
export let DOCKS = STATIONS.map((s) => {
  const toRouter = flat(ROUTER_POS).sub(flat(s.pos)).normalize();
  return flat(s.pos).add(toRouter.multiplyScalar(1.15));
});

/** Building center for each workshop, nudged away from the dock. */
export let BUILDINGS = STATIONS.map((s) => {
  const away = flat(s.pos).sub(flat(ROUTER_POS)).normalize();
  return flat(s.pos).add(away.multiplyScalar(0.35));
});

/** Yaw that turns a station's local +z axis toward the Router. */
export let STATION_YAW = STATIONS.map((s) => {
  const d = flat(ROUTER_POS).sub(flat(s.pos));
  return Math.atan2(d.x, d.z);
});

const at = (v: THREE.Vector3, y: number) => new THREE.Vector3(v.x, y, v.z);

export const INGRESS_CURVE = new THREE.LineCurve3(
  at(INGRESS_POS, PARCEL_Y).add(new THREE.Vector3(0.2, 0, 0)),
  carouselPoint(ENTRY_ANGLE),
);

export const INGRESS_RAIL = new THREE.LineCurve3(
  at(INGRESS_POS, RAIL_Y).add(new THREE.Vector3(0.6, 0, 0)),
  carouselPoint(ENTRY_ANGLE, ROUTER_OUTER_R + 0.05, RAIL_Y),
);

const transitCurve = (i: number, y: number, startRadius: number) => {
  const a = EXIT_ANGLES[i]!;
  const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const start = carouselPoint(a, startRadius, y);
  const end = at(DOCKS[i]!, y);
  const toRouter = flat(ROUTER_POS).sub(flat(STATIONS[i]!.pos)).normalize();
  const c1 = start.clone().add(dir.clone().multiplyScalar(2.6));
  const c2 = end.clone().add(toRouter.multiplyScalar(2.4));
  return new THREE.CubicBezierCurve3(start, c1, c2, end);
};

export let TRANSIT_CURVES = STATIONS.map((_, i) => transitCurve(i, PARCEL_Y, CAROUSEL_R));
export let TRANSIT_RAILS = STATIONS.map((_, i) => transitCurve(i, RAIL_Y, ROUTER_OUTER_R + 0.05));

export let RETURN_CURVES = STATIONS.map((s) => {
  const y = 0.42;
  const toWd = flat(WATCHDOG_POS).sub(flat(s.pos)).normalize();
  const start = at(flat(s.pos).add(toWd.clone().multiplyScalar(1.45)), y);
  const fromWd = flat(s.pos).sub(flat(WATCHDOG_POS)).normalize();
  const end = at(flat(WATCHDOG_POS).add(fromWd.clone().multiplyScalar(1.25)), y);
  return new THREE.CubicBezierCurve3(
    start,
    start.clone().add(new THREE.Vector3(1.8, 0, 0)),
    end.clone().add(fromWd.multiplyScalar(2.2)),
    end,
  );
});

export type RuntimeStationInput = {
  id: string;
  name: string;
  template?: string;
  threadId?: string;
  kind?: StationKind;
};

const accentFor = (id: string, template?: string) => {
  const byTemplate: Record<string, string> = {
    research: '#7F8FF4',
    code: '#48B5A6',
    content: '#E9A07A',
    data: '#A58FEA',
    review: '#BCA77E',
    ops: '#D99A1E',
  };
  if (template && byTemplate[template]) return byTemplate[template];
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ['#7F8FF4', '#48B5A6', '#E9A07A', '#A58FEA', '#BCA77E'][Math.abs(hash) % 5]!;
};

const kindFor = (template?: string): StationKind =>
  template === 'code' || template === 'content' || template === 'data' || template === 'review'
    ? template
    : template === 'ops'
      ? 'data'
      : 'research';

export const stationKindForTemplate = kindFor;

/** Rebuild all geometry derived from the current real Worker roster. */
export function setRuntimeStations(workers: readonly RuntimeStationInput[]): StationSpec[] {
  const count = workers.length;
  // The river occupies roughly x=-1.4..0.6. Keep every worker pad clearly on
  // its right bank, leaving the Router and Ingress on the left side.
  const workerFieldX = 2.1;
  if (count === 0) {
    STATIONS = [];
  } else {
    const ringCount = count <= 8 ? 1 : Math.ceil(count / 8);
    const perRing = Math.ceil(count / ringCount);
    STATIONS = workers.map((worker, index) => {
      const ring = Math.floor(index / perRing);
      const indexInRing = index % perRing;
      const ringSize = Math.min(perRing, count - ring * perRing);
      const radius = 5.4 + ring * 2.6 + Math.max(0, ringSize - 5) * 0.45;
      // Keep the worker arc on the Router's right side. A full circle places
      // one worker directly beside the Router when the roster has 8 items.
      const spread = ringSize <= 1 ? 0 : indexInRing / (ringSize - 1);
      const angle = -Math.PI / 2 + spread * Math.PI;
      return {
        workerId: worker.id,
        threadId: worker.threadId,
        kind: worker.kind ?? kindFor(worker.template),
        label: worker.name || worker.id,
        cnRole: worker.kind === 'review' ? '质检把关' : worker.template === 'code' ? '代码构建' : worker.template === 'ops' ? '运维支持' : '探索检索',
        accent: accentFor(worker.id, worker.kind ?? worker.template),
        pos: new THREE.Vector3(workerFieldX + Math.cos(angle) * radius, 0, Math.sin(angle) * radius),
      };
    });
  }
  EXIT_ANGLES = STATIONS.map((s) => Math.atan2(s.pos.z - ROUTER_POS.z, s.pos.x - ROUTER_POS.x));
  DOCKS = STATIONS.map((s) => {
    const toRouter = flat(ROUTER_POS).sub(flat(s.pos)).normalize();
    return flat(s.pos).add(toRouter.multiplyScalar(1.15));
  });
  BUILDINGS = STATIONS.map((s) => {
    const away = flat(s.pos).sub(flat(ROUTER_POS)).normalize();
    return flat(s.pos).add(away.multiplyScalar(0.35));
  });
  STATION_YAW = STATIONS.map((s) => {
    const d = flat(ROUTER_POS).sub(flat(s.pos));
    return Math.atan2(d.x, d.z);
  });
  TRANSIT_CURVES = STATIONS.map((_, i) => transitCurve(i, PARCEL_Y, CAROUSEL_R));
  TRANSIT_RAILS = STATIONS.map((_, i) => transitCurve(i, RAIL_Y, ROUTER_OUTER_R + 0.05));
  RETURN_CURVES = STATIONS.map((s) => {
    const y = 0.42;
    const toWd = flat(WATCHDOG_POS).sub(flat(s.pos)).normalize();
    const start = at(flat(s.pos).add(toWd.clone().multiplyScalar(1.45)), y);
    const fromWd = flat(s.pos).sub(flat(WATCHDOG_POS)).normalize();
    const end = at(flat(WATCHDOG_POS).add(fromWd.clone().multiplyScalar(1.25)), y);
    return new THREE.CubicBezierCurve3(
      start,
      start.clone().add(new THREE.Vector3(1.8, 0, 0)),
      end.clone().add(fromWd.multiplyScalar(2.2)),
      end,
    );
  });
  return STATIONS;
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Shortest signed angular delta from a to b. */
export const angleDelta = (a: number, b: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};
