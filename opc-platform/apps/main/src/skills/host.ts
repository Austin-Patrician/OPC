import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiSkillCatalog, PiSkillView } from '@opc/shared/ipc';
import { scanSkills, type ScanSkillsResult, type ScannedSkill } from './scanner';

/**
 * The skills OPC found on this machine, and which ones the boss turned off.
 *
 * There is no trust gate here, on purpose: a skill is Markdown. Reading it can
 * only cost prompt tokens, never run code. What *does* run code is a script the
 * skill tells the agent to call, and that goes through `bash` like everything
 * else — sandboxed, counted, and visible in the transcript.
 *
 * The store keeps **disabled** ids rather than enabled ones, so a skill the user
 * installs later (with `npx skills add`, or by dropping a folder) is live on the
 * next request instead of silently ignored.
 */

interface Store {
  version: 1;
  /** Skill ids (absolute SKILL.md paths) the boss switched off. */
  disabled: string[];
}

export interface PiSkillHostOptions {
  userDataDir: string;
  homeDir?: string;
  projectDir?: string;
  scan?: typeof scanSkills;
}

/** A scan reads ~16 small files; cheap, but not free on every registry build. */
const SCAN_TTL_MS = 2_000;

/** Prompt budget per skill: enough to recognize the skill, not enough to bloat. */
const DESCRIPTION_LIMIT = 300;

export class PiSkillHost {
  private readonly storeFile: string;
  private readonly homeDir: string;
  private readonly projectDir: string;
  private readonly scanFn: typeof scanSkills;

  private store: Store;
  private lastScan?: { at: number; result: ScanSkillsResult };

  constructor(options: PiSkillHostOptions) {
    this.storeFile = path.join(options.userDataDir, 'pi-skills.json');
    this.homeDir = options.homeDir ?? os.homedir();
    this.projectDir = options.projectDir ?? process.cwd();
    this.scanFn = options.scan ?? scanSkills;
    this.store = this.readStore();
  }

  /** Every discovered skill, including the disabled ones (the UI shows both). */
  list(): PiSkillCatalog {
    // A user-initiated refresh must see the disk now, not a 2s-old snapshot.
    const result = this.scan();
    this.prune(result);
    return {
      generatedAt: Date.now(),
      roots: result.roots,
      entries: result.entries.map((skill) => this.view(skill)),
    };
  }

  /** What the runtime may use: enabled skills, newest scan. */
  enabled(): ScannedSkill[] {
    const result = this.scanCached();
    this.prune(result);
    return result.entries.filter((skill) => !this.store.disabled.includes(skill.id));
  }

  setEnabled(id: string, enabled: boolean): PiSkillCatalog {
    const result = this.scan();
    this.prune(result);
    const skill = result.entries.find((candidate) => candidate.id === id);
    if (!skill) throw new Error('技能不存在：磁盘上找不到它，请刷新后重试');

    this.store.disabled = enabled
      ? this.store.disabled.filter((value) => value !== id)
      : [...new Set([...this.store.disabled, id])];
    this.writeStore();
    return this.list();
  }

  private scan(): ScanSkillsResult {
    const result = this.scanFn({ homeDir: this.homeDir, projectDir: this.projectDir });
    this.lastScan = { at: Date.now(), result };
    return result;
  }

  private scanCached(): ScanSkillsResult {
    if (this.lastScan && Date.now() - this.lastScan.at < SCAN_TTL_MS) return this.lastScan.result;
    return this.scan();
  }

  /** Drops ids for skills that are gone, so uninstalling one is not remembered forever. */
  private prune(result: ScanSkillsResult): void {
    const present = new Set(result.entries.map((entry) => entry.id));
    const disabled = this.store.disabled.filter((id) => present.has(id));
    if (disabled.length === this.store.disabled.length) return;
    this.store = { version: 1, disabled };
    this.writeStore();
  }

  private view(skill: ScannedSkill): PiSkillView {
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      dir: skill.dir,
      file: skill.file,
      files: skill.files.length,
      enabled: !this.store.disabled.includes(skill.id),
      promptTokens: promptTokens(skill),
    };
  }

  private readStore(): Store {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as Partial<Store>;
      return { version: 1, disabled: strings(parsed.disabled) };
    } catch {
      return { version: 1, disabled: [] };
    }
  }

  private writeStore(): void {
    try {
      fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
      const temp = `${this.storeFile}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.store, null, 2)}\n`, 'utf8');
      fs.renameSync(temp, this.storeFile);
    } catch (error) {
      console.warn('保存技能开关失败', error);
    }
  }
}

/** The one-line description the prompt shows, trimmed to the budget. */
export function skillSummary(skill: ScannedSkill): string {
  const description = skill.description.replace(/\s+/g, ' ').trim();
  if (description.length <= DESCRIPTION_LIMIT) return description;
  return `${description.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

/**
 * Rough prompt cost of advertising one skill: the name plus its summary.
 * Latin text is ~4 chars/token, CJK ~1.5; 3 is a deliberately pessimistic mix.
 */
export function promptTokens(skill: ScannedSkill): number {
  return Math.ceil((skill.name.length + skillSummary(skill).length + 8) / 3);
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
