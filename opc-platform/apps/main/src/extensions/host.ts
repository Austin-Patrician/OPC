import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Extension } from '@earendil-works/pi-durable';
import type { PiExtensionCatalog, PiExtensionView } from '@opc/shared/ipc';
import { extensionSlug, scanPiExtensions, type ScanResult, type ScannedExtension } from './scanner';
import { loadPiExtension, type LoadedPiExtension } from './shim';

/**
 * Owns the Pi extensions OPC has discovered and the ones the user turned on.
 *
 * Two rules shape this class:
 *   1. Scanning never imports. Listing a directory is safe; importing a module
 *      runs its author's code, so it happens only for enabled + trusted entries.
 *   2. Enabling is company-wide. Per-employee opt-out stays where it already
 *      lives: `EmployeeToolPolicy.disabledExtensions`, keyed by our registry name.
 *
 * Loading is cached by mtime, so `/reload`-style edits on disk are picked up on
 * the next scan without restarting the app.
 */

interface Store {
  version: 1;
  /** Extension ids (absolute paths) the user turned on. */
  enabled: string[];
  /** Ids whose code the user accepted running in the main process. */
  trusted: string[];
}

export interface PiExtensionHostOptions {
  /** Where `pi-extensions.json` lives; normally `app.getPath('userData')`. */
  userDataDir: string;
  homeDir?: string;
  projectDir?: string;
  /** Injection points for tests. */
  scan?: typeof scanPiExtensions;
  load?: typeof loadPiExtension;
}

export interface LoadedSlot {
  id: string;
  /** Registry / policy name, e.g. `pi.my-tools`. */
  name: string;
  extension: Extension;
}

/** A scan is cheap but not free; the hot path (every registry build) reuses one briefly. */
const SCAN_TTL_MS = 2_000;

export class PiExtensionHost {
  private readonly storeFile: string;
  private readonly homeDir: string;
  private readonly projectDir: string;
  private readonly scanFn: typeof scanPiExtensions;
  private readonly load: typeof loadPiExtension;

  private store: Store;
  private lastScan?: { at: number; result: ScanResult };
  private readonly cache = new Map<string, { mtime: number; load?: LoadedPiExtension; error?: string }>();
  /** id → registry name, rebuilt from each scan so names stay stable per path. */
  private names = new Map<string, string>();

  constructor(options: PiExtensionHostOptions) {
    this.storeFile = path.join(options.userDataDir, 'pi-extensions.json');
    this.homeDir = options.homeDir ?? os.homedir();
    this.projectDir = options.projectDir ?? process.cwd();
    this.scanFn = options.scan ?? scanPiExtensions;
    this.load = options.load ?? loadPiExtension;
    this.store = this.readStore();
  }

  /** Loads every enabled extension once; safe to call on each registry build. */
  async ensureLoaded(): Promise<void> {
    const result = this.scanCached();
    this.names = registryNames(result.entries);
    this.prune(result);
    for (const entry of result.entries) {
      if (!this.store.enabled.includes(entry.id)) continue;
      await this.loadOne(entry);
    }
  }

  /** What `buildRegistry` installs: enabled, loaded, and deduplicated by name. */
  slots(): LoadedSlot[] {
    const slots: LoadedSlot[] = [];
    for (const [id, name] of this.names) {
      if (!this.store.enabled.includes(id)) continue;
      const cached = this.cache.get(id);
      if (!cached?.load) continue;
      slots.push({ id, name, extension: { ...cached.load.extension, name } });
    }
    return slots;
  }

  async list(): Promise<PiExtensionCatalog> {
    const result = this.scan();
    this.names = registryNames(result.entries);
    this.prune(result);
    for (const entry of result.entries) {
      if (this.store.enabled.includes(entry.id)) await this.loadOne(entry);
    }

    return {
      generatedAt: Date.now(),
      roots: result.roots,
      entries: result.entries.map((entry) => this.view(entry)),
    };
  }

  /** Enabling runs the module, so an untrusted id needs explicit consent first. */
  async setEnabled(id: string, enabled: boolean, trusted = false): Promise<PiExtensionCatalog> {
    const result = this.scan();
    this.names = registryNames(result.entries);
    const entry = result.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error('扩展不存在：磁盘上找不到它，请刷新后重试');

    if (enabled && !this.store.trusted.includes(id)) {
      if (!trusted) throw new Error('首次启用需要确认信任：该扩展会以主进程权限运行任意代码');
      this.store.trusted = [...this.store.trusted, id];
    }

    this.store.enabled = enabled
      ? [...new Set([...this.store.enabled, id])]
      : this.store.enabled.filter((value) => value !== id);

    if (!enabled) this.cache.delete(id);
    this.writeStore();

    if (enabled) await this.loadOne(entry);
    return this.list();
  }

  private scan(): ScanResult {
    const result = this.scanFn({ homeDir: this.homeDir, projectDir: this.projectDir });
    this.lastScan = { at: Date.now(), result };
    return result;
  }

  private scanCached(): ScanResult {
    if (this.lastScan && Date.now() - this.lastScan.at < SCAN_TTL_MS) return this.lastScan.result;
    return this.scan();
  }

  /**
   * Forgets ids that are no longer on disk (uninstalled, renamed, moved).
   *
   * Without this, a stale `enabled` id would keep the store from ever shrinking,
   * and a re-created folder at the same path would silently come back enabled
   * with its old trust — the one case where "it was trusted once" is the wrong
   * memory to keep.
   */
  private prune(result: ScanResult): void {
    const present = new Set(result.entries.map((entry) => entry.id));
    const keep = (value: string) => present.has(value);
    const enabled = this.store.enabled.filter(keep);
    const trusted = this.store.trusted.filter(keep);
    if (enabled.length === this.store.enabled.length && trusted.length === this.store.trusted.length) return;

    this.store = { version: 1, enabled, trusted };
    for (const id of this.cache.keys()) if (!present.has(id)) this.cache.delete(id);
    this.writeStore();
  }

  private async loadOne(entry: ScannedExtension): Promise<void> {
    const cached = this.cache.get(entry.id);
    if (cached && cached.mtime === entry.mtime && (cached.load || cached.error)) return;

    const name = this.names.get(entry.id) ?? `pi.${extensionSlug(entry.name)}`;
    try {
      const loaded = await this.load(entry.entry, { name, dir: entry.dir });
      this.cache.set(entry.id, { mtime: entry.mtime, load: loaded });
    } catch (error) {
      this.cache.set(entry.id, {
        mtime: entry.mtime,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(`加载扩展失败 ${entry.name}`, error);
    }
  }

  private view(entry: ScannedExtension): PiExtensionView {
    const enabled = this.store.enabled.includes(entry.id);
    const cached = this.cache.get(entry.id);
    const loaded = cached && cached.mtime === entry.mtime ? cached.load : undefined;
    const error = cached && cached.mtime === entry.mtime ? cached.error : undefined;

    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      version: entry.version,
      scope: entry.scope,
      entry: entry.entry,
      enabled,
      trusted: this.store.trusted.includes(entry.id),
      loaded: Boolean(loaded),
      tools: loaded?.tools ?? [],
      events: loaded?.events ?? [],
      commands: loaded?.commands ?? [],
      unsupported: loaded?.unsupported ?? [],
      ...(error ? { error } : {}),
    };
  }

  private readStore(): Store {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as Partial<Store>;
      return {
        version: 1,
        enabled: strings(parsed.enabled),
        trusted: strings(parsed.trusted),
      };
    } catch {
      return { version: 1, enabled: [], trusted: [] };
    }
  }

  private writeStore(): void {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const temp = `${this.storeFile}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.store, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, this.storeFile);
    } catch (error) {
      console.warn('保存扩展开关失败', error);
    }
  }
}

/**
 * Registry names must be stable across scans (the employee policy stores them)
 * and unique (a registry rejects duplicate installs silently).
 */
function registryNames(entries: readonly ScannedExtension[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const entry of entries) {
    const base = `pi.${extensionSlug(entry.name)}`;
    let name = base;
    for (let index = 2; used.has(name); index += 1) name = `${base}-${index}`;
    used.add(name);
    names.set(entry.id, name);
  }
  return names;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
