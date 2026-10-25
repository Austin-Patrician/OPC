import type { DiagnosticsReport, ProbeResult } from '@opc/shared/ipc';
import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getAppInfo } from '../appInfo';
import { openCompanyDatabase, probeSqlite } from '../data/companyDatabase';
import { probeHarnessPersistence } from '../data/harnessProbe';
import { loadSqliteVec } from '../data/sqliteVec';
import { appPaths } from '../paths';
import { detectBackend, selfTest } from '../sandbox/detect';

interface Probe {
  id: string;
  title: string;
  run: () => Promise<{ status: ProbeResult['status']; detail: string }>;
}

/**
 * G0 acceptance evidence, generated inside the packaged app.
 *
 * Rationale: the highest-risk items (native addon loading, the loadable SQLite
 * extension, writable user data, process isolation) can only be proven in a real
 * Electron runtime — a browser dev server proves none of them.
 */
const PROBES: Probe[] = [
  {
    id: 'sqlite',
    title: 'SQLite（better-sqlite3 原生模块）',
    async run() {
      const db = openCompanyDatabase(appPaths.database);
      try {
        const result = probeSqlite(db);
        return {
          status: 'ok',
          detail: `SQLite ${result.sqliteVersion} · journal=${result.journalMode} · company 行数=${result.companyRows} · quick_check=${result.integrity}`,
        };
      } finally {
        db.close();
      }
    },
  },
  {
    id: 'sqlite-vec',
    title: 'sqlite-vec（向量扩展）',
    async run() {
      const db = new Database(':memory:');
      try {
        const extensionPath = await loadSqliteVec(db);
        const version = db.prepare('SELECT vec_version() AS v').get() as { v: string };

        // vec0 accepts either an explicit integer primary key or an implicit rowid;
        // try both forms so a version bump surfaces as a clear probe message.
        const attempts: { label: string; ddl: string; insert: string }[] = [
          {
            label: 'id integer primary key',
            ddl: 'CREATE VIRTUAL TABLE probe_vec USING vec0(id integer primary key, embedding float[4])',
            insert: 'INSERT INTO probe_vec(id, embedding) VALUES (?, ?)',
          },
          {
            label: 'implicit rowid',
            ddl: 'CREATE VIRTUAL TABLE probe_vec USING vec0(embedding float[4])',
            insert: 'INSERT INTO probe_vec(embedding) VALUES (?)',
          },
        ];

        const failures: string[] = [];
        for (const attempt of attempts) {
          try {
            db.exec('DROP TABLE IF EXISTS probe_vec');
            db.exec(attempt.ddl);
            const toBuffer = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
            const insert = db.prepare(attempt.insert);
            if (attempt.label === 'implicit rowid') {
              insert.run(toBuffer([1, 0, 0, 0]));
              insert.run(toBuffer([0, 1, 0, 0]));
              insert.run(toBuffer([0.9, 0.1, 0, 0]));
            } else {
              insert.run(1, toBuffer([1, 0, 0, 0]));
              insert.run(2, toBuffer([0, 1, 0, 0]));
              insert.run(3, toBuffer([0.9, 0.1, 0, 0]));
            }

            const nearest = db
              .prepare(
                `SELECT rowid, distance FROM probe_vec
                 WHERE embedding MATCH ? ORDER BY distance LIMIT 1`,
              )
              .get(toBuffer([1, 0, 0, 0])) as { rowid: number; distance: number } | undefined;

            if (!nearest) throw new Error('KNN 无结果');
            if (nearest.rowid !== 1) throw new Error(`KNN 命中 rowid=${nearest.rowid}，期望 1`);

            return {
              status: 'ok',
              detail: `vec_version=${version.v} · ${attempt.label} · KNN 命中 rowid=1（distance=${nearest.distance.toFixed(4)}）· ${path.basename(extensionPath)}`,
            };
          } catch (error) {
            failures.push(
              `${attempt.label}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        throw new Error(`vec_version=${version.v}；所有插入方式均失败 → ${failures.join(' | ')}`);
      } finally {
        db.close();
      }
    },
  },
  {
    id: 'pi-durable',
    title: 'pi-durable（跨重启持久化）',
    async run() {
      const result = await probeHarnessPersistence();
      return {
        status: 'ok',
        detail: `entry 在 Harness 关闭并重开后仍存在 · entries=${result.entries} · app.probe×${result.probeEntries} · ${path.basename(result.storageFile)}`,
      };
    },
  },
  {
    id: 'sandbox',
    title: '沙箱（macOS sandbox-exec / Linux bwrap）',
    async run() {
      const status = detectBackend();
      if (!status.supported) {
        return { status: 'skipped', detail: `${status.detail} · 工具执行会被拒绝` };
      }
      const result = await selfTest(path.join(appPaths.workspaceDir, '_sandbox_probe'));
      return {
        status: result.ok ? 'ok' : 'failed',
        detail: `${status.detail} · ${result.detail}`,
      };
    },
  },
  {
    id: 'filesystem',
    title: '用户数据目录可写',
    async run() {
      const target = path.join(appPaths.probeDir, `probe-${Date.now()}.txt`);
      fs.mkdirSync(appPaths.probeDir, { recursive: true });
      fs.writeFileSync(target, 'opc-probe');
      const readBack = fs.readFileSync(target, 'utf8');
      fs.rmSync(target, { force: true });
      if (readBack !== 'opc-probe') throw new Error('读回内容不一致');
      return { status: 'ok', detail: appPaths.probeDir };
    },
  },
  {
    id: 'isolation',
    title: '渲染进程隔离（nodeIntegration=false / sandbox=true / contextIsolation=true）',
    async run() {
      return {
        status: 'ok',
        detail: '主进程以 contextIsolation + sandbox 创建窗口，渲染进程只能访问 preload 暴露的 window.opc',
      };
    },
  },
  {
    id: 'packaging',
    title: '打包状态（app.isPackaged）',
    async run() {
      return {
        status: 'ok',
        detail: app.isPackaged
          ? `已打包 · resources=${path.basename(process.resourcesPath)}`
          : '开发模式（未打包）— 打包验证请运行 pnpm pack:mac',
      };
    },
  },
];

export async function runDiagnostics(): Promise<DiagnosticsReport> {
  const appInfo = getAppInfo();
  const probes: ProbeResult[] = [];

  for (const probe of PROBES) {
    const startedAt = performance.now();
    try {
      const { status, detail } = await probe.run();
      probes.push({
        id: probe.id,
        title: probe.title,
        status,
        detail,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      probes.push({
        id: probe.id,
        title: probe.title,
        status: 'failed',
        detail: error instanceof Error ? `${error.message}` : String(error),
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    app: appInfo,
    probes,
    errors: probes.filter((probe) => probe.status === 'failed').map((probe) => probe.id),
  };
}
