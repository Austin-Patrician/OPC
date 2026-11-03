import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * Wipes business data (work, chats, memories, executors) but keeps settings,
 * model providers and credentials. Used to start from a clean company; the
 * first-run seed then creates the one default executor again.
 */
export function resetCompany(db: CompanyDatabase): Record<string, number> {
  const tables = [
    'acceptance',
    'artifact',
    'task_step',
    'task',
    'report',
    'event',
    'worker',
    'thread',
    'memory',
    'conversation',
    'message',
  ];

  const counts: Record<string, number> = {};
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const table of tables) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) continue;
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      db.exec(`DELETE FROM ${table};`);
      counts[table] = before;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
  return counts;
}
