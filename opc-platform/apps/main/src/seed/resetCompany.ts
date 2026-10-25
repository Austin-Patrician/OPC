import type { CompanyDatabase } from '../data/companyDatabase';

/**
 * Wipes business data (people, org, work, chats, budgets) but keeps settings,
 * model providers and credentials. Used to start from a clean company; the
 * first-run seed then creates the two-department company again.
 */
export function resetCompany(db: CompanyDatabase): Record<string, number> {
  const tables = [
    'acceptance',
    'artifact',
    'task_step',
    'task',
    'position',
    'employee',
    'department',
    'budget_ledger',
    'budget_reservation',
    'budget',
    'employee_memory',
    'agent_candidate',
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
