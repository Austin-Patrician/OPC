import type { RuntimePrototypeVariant, WorkerStatus } from '../../../data/runtimeData';
import { STATIONS } from './worldConfig';

export type ParcelPhase = 'ingress' | 'sort' | 'transit' | 'unbox' | 'absorb' | 'hold' | 'fault';

export interface Parcel {
  active: boolean;
  id: number;
  worker: number;
  phase: ParcelPhase;
  t: number;
  /** Seconds since entering the current phase. */
  age: number;
  /** Correlation id shown on the parcel tag. */
  corr: string;
}

export interface Capsule {
  active: boolean;
  worker: number;
  t: number;
  failed: boolean;
}

export interface StationFx {
  workUntil: number;
  flashAt: number;
  pendingReports: number[];
}

export interface SimStats {
  ingress: number;
  sorting: number;
  transit: number;
  unboxing: number;
  working: number;
  reports: number;
  delivered: number;
  faults: number;
  lastBeatAgo: number;
  workerActivity: WorkerActivity[];
  workerQueue: number[];
}

export type WorkerActivity = 'idle' | 'incoming' | 'holding' | 'unboxing' | 'working' | 'completed' | 'fault';

export const PHASE_DURATION: Record<Exclude<ParcelPhase, 'hold'>, number> = {
  ingress: 1.9,
  sort: 1.7,
  transit: 3.1,
  unbox: 1.35,
  absorb: 0.55,
  fault: 1.8,
};

export const CAPSULE_DURATION = 2.6;
export const HEARTBEAT_PERIOD = 1.2;

const PARCEL_POOL = 10;
const CAPSULE_POOL = 10;

const CORR_PREFIX = ['research', 'code', 'content', 'data', 'review'];

/**
 * Deterministic-ish simulation of the Router → Worker → Watchdog pipeline.
 * Rendering reads this object every frame; React only receives periodic summaries.
 */
export class RuntimeSim {
  time = 0;
  parcels: Parcel[] = Array.from({ length: PARCEL_POOL }, () => ({
    active: false,
    id: 0,
    worker: 0,
    phase: 'ingress' as ParcelPhase,
    t: 0,
    age: 0,
    corr: '',
  }));
  capsules: Capsule[] = Array.from({ length: CAPSULE_POOL }, () => ({
    active: false,
    worker: 0,
    t: 0,
    failed: false,
  }));
  stations: StationFx[] = STATIONS.map(() => ({ workUntil: -1, flashAt: -10, pendingReports: [] }));
  /** Live mode disables synthetic arrivals; real task objects render separately. */
  autoSpawn = true;
  statuses: WorkerStatus[] = STATIONS.map(() => 'Running' as WorkerStatus);
  variant: RuntimePrototypeVariant = 'normal';
  lastBeat = 0;
  lastArrivalAt = -10;
  lastReportAt = -10;
  delivered = 128;
  faults = 0;
  /** Derived once per simulation tick for animation consumers. */
  sortingLead: Parcel | null = null;
  sortingCount = 0;
  scanning = false;
  ingressing = false;
  parcelByWorker: (Parcel | null)[] = STATIONS.map(() => null);
  workerQueue: number[] = STATIONS.map(() => 0);
  tagParcel: Parcel | null = null;
  tagParcelByWorker: (Parcel | null)[] = STATIONS.map(() => null);
  private nextSpawn = 0.4;
  private seq = 40;
  private rng = 7;

  private random() {
    // Small LCG so the warm-up looks the same on every load.
    this.rng = (this.rng * 16807) % 2147483647;
    return (this.rng - 1) / 2147483646;
  }

  setState(statuses: WorkerStatus[], variant: RuntimePrototypeVariant) {
    const wasEmpty = this.variant === 'empty';
    this.statuses = statuses;
    if (this.stations.length !== statuses.length) {
      this.stations = statuses.map((_, i) => this.stations[i] ?? ({ workUntil: -1, flashAt: -10, pendingReports: [] }));
    }
    this.variant = variant;
    if (variant === 'empty') this.clear();
    if (wasEmpty && variant !== 'empty') this.nextSpawn = this.time + 0.2;
    // Release parcels held at a worker that is no longer waiting.
    this.parcels.forEach((p) => {
      if (p.active && p.phase === 'hold' && this.statuses[p.worker] !== 'Waiting')
        this.enter(p, 'unbox');
    });
  }

  setLiveMode(live: boolean) {
    this.autoSpawn = !live;
    if (live) this.clear();
  }

  clear() {
    this.parcels.forEach((p) => (p.active = false));
    this.capsules.forEach((c) => (c.active = false));
    this.stations.forEach((s) => {
      s.workUntil = -1;
      s.pendingReports = [];
    });
    this.refreshDerived();
  }

  /** Fast-forward so the world is already busy on first paint. */
  warmUp(seconds: number) {
    const step = 1 / 30;
    for (let t = 0; t < seconds; t += step) this.update(step);
  }

  private enter(p: Parcel, phase: ParcelPhase) {
    p.phase = phase;
    p.t = 0;
    p.age = 0;
  }

  private pickWorker(): number | null {
    const weights: number[] = this.statuses.map((s, i) => {
      if (s === 'Running') return 3;
      if (s === 'Waiting') {
        const holding = this.parcels.some((p) => p.active && p.worker === i);
        return holding ? 0 : 1;
      }
      if (s === 'Failed') return this.variant === 'failed' ? 1.4 : 0.5;
      return 0;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let r = this.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  spawn(worker?: number) {
    const slot = this.parcels.find((p) => !p.active);
    if (!slot) return false;
    const w = worker ?? this.pickWorker();
    if (w === null || w === undefined) return false;
    this.seq += 1;
    slot.active = true;
    slot.id = this.seq;
    slot.worker = w;
    slot.corr = `${CORR_PREFIX[w]}-${String(this.seq).padStart(3, '0')}`;
    this.enter(slot, 'ingress');
    return true;
  }

  private emitCapsule(worker: number, failed: boolean) {
    const slot = this.capsules.find((c) => !c.active);
    if (!slot) return;
    slot.active = true;
    slot.worker = worker;
    slot.t = 0;
    slot.failed = failed;
  }

  update(dt: number) {
    this.time += dt;
    const now = this.time;

    if (this.autoSpawn && this.variant !== 'empty' && now >= this.nextSpawn) {
      const inFlight = this.parcels.filter((p) => p.active && p.phase !== 'hold').length;
      if (inFlight < 6) this.spawn();
      this.nextSpawn = now + 1.35 + this.random() * 0.9;
    }

    if (this.variant !== 'stale' && now - this.lastBeat >= HEARTBEAT_PERIOD) this.lastBeat = now;

    for (const p of this.parcels) {
      if (!p.active) continue;
      p.age += dt;
      if (p.phase === 'hold') continue;
      const duration = PHASE_DURATION[p.phase];
      p.t = Math.min(1, p.age / duration);
      if (p.t < 1) continue;

      const status = this.statuses[p.worker]!;
      switch (p.phase) {
        case 'ingress':
          this.enter(p, 'sort');
          break;
        case 'sort':
          this.enter(p, 'transit');
          break;
        case 'transit':
          this.lastArrivalAt = now;
          this.enter(p, status === 'Waiting' ? 'hold' : 'unbox');
          break;
        case 'unbox':
          this.enter(p, status === 'Failed' ? 'fault' : 'absorb');
          break;
        case 'absorb': {
          const fx = this.stations[p.worker]!;
          const workTime = 2.2 + this.random() * 1.6;
          fx.workUntil = Math.max(fx.workUntil, now) + workTime;
          fx.flashAt = now;
          fx.pendingReports.push(fx.workUntil);
          p.active = false;
          break;
        }
        case 'fault':
          this.faults += 1;
          this.stations[p.worker]!.flashAt = now;
          this.emitCapsule(p.worker, true);
          p.active = false;
          break;
      }
    }

    this.stations.forEach((fx, i) => {
      if (!fx.pendingReports.length) return;
      if (now >= fx.pendingReports[0]!) {
        fx.pendingReports.shift();
        this.emitCapsule(i, false);
      }
    });

    for (const c of this.capsules) {
      if (!c.active) continue;
      c.t += dt / CAPSULE_DURATION;
      if (c.t >= 1) {
        c.active = false;
        this.lastReportAt = now;
        if (!c.failed) this.delivered += 1;
      }
    }
    this.refreshDerived();
  }

  private refreshDerived() {
    this.sortingLead = null;
    this.sortingCount = 0;
    this.scanning = false;
    this.ingressing = false;
    this.parcelByWorker.fill(null);
    this.workerQueue.fill(0);
    for (const parcel of this.parcels) {
      if (!parcel.active) continue;
      this.workerQueue[parcel.worker] = (this.workerQueue[parcel.worker] ?? 0) + 1;
      const previous = this.parcelByWorker[parcel.worker];
      if (!previous || parcel.age > previous.age) this.parcelByWorker[parcel.worker] = parcel;
      if (parcel.phase === 'ingress' && parcel.t < 0.25) this.ingressing = true;
      if (parcel.phase === 'sort') {
        this.sortingCount += 1;
        if (!this.sortingLead || parcel.age > this.sortingLead.age) this.sortingLead = parcel;
        if (parcel.age < 0.5) this.scanning = true;
      }
    }
    // Select the same representative parcel used by the floating tag once per
    // simulation tick, instead of filtering and sorting the pool per label frame.
    const phaseOrder: Record<ParcelPhase, number> = {
      transit: 0,
      unbox: 1,
      absorb: 1,
      hold: 2,
      fault: 3,
      ingress: 4,
      sort: 5,
    };
    this.tagParcel = null;
    this.tagParcelByWorker.fill(null);
    for (const parcel of this.parcels) {
      if (!parcel.active || parcel.phase === 'ingress' || parcel.phase === 'sort') continue;
      const currentTag = this.tagParcel;
      if (!currentTag || phaseOrder[parcel.phase] < phaseOrder[currentTag.phase] ||
        (phaseOrder[parcel.phase] === phaseOrder[currentTag.phase] && parcel.t < currentTag.t)) {
        this.tagParcel = parcel;
      }
      const current = this.tagParcelByWorker[parcel.worker];
      if (!current || phaseOrder[parcel.phase] < phaseOrder[current.phase] ||
        (phaseOrder[parcel.phase] === phaseOrder[current.phase] && parcel.t < current.t)) {
        this.tagParcelByWorker[parcel.worker] = parcel;
      }
    }
  }

  isWorking(i: number) {
    return this.stations[i]!.workUntil > this.time;
  }

  stats(): SimStats {
    const count = (phase: ParcelPhase) =>
      this.parcels.filter((p) => p.active && p.phase === phase).length;
    return {
      ingress: count('ingress'),
      sorting: count('sort'),
      transit: count('transit'),
      unboxing: count('unbox') + count('absorb') + count('fault'),
      working: this.stations.filter((_, i) => this.isWorking(i)).length,
      reports: this.capsules.filter((c) => c.active).length,
      delivered: this.delivered,
      faults: this.faults,
      lastBeatAgo: this.variant === 'stale' ? 48 : Math.max(0, this.time - this.lastBeat),
      workerActivity: this.stations.map((_, i) => {
        let fault = false;
        let unboxing = false;
        let holding = false;
        for (const p of this.parcels) {
          if (!p.active || p.worker !== i) continue;
          if (p.phase === 'fault') fault = true;
          else if (p.phase === 'unbox' || p.phase === 'absorb') unboxing = true;
          else if (p.phase === 'hold') holding = true;
        }
        if (fault) return 'fault';
        if (unboxing) return 'unboxing';
        if (this.isWorking(i)) return 'working';
        if (holding) return 'holding';
        if (this.workerQueue[i]) return 'incoming';
        return 'idle';
      }),
      workerQueue: [...this.workerQueue],
    };
  }
}
