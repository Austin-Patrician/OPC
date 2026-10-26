import type Database from 'better-sqlite3';

/**
 * sqlite-vec: the vector index for memory (§6.5).
 *
 * The extension is loaded per connection by whoever needs it — the business
 * database does not, because ranking runs in JS over stored float32 blobs (see
 * memoryService), so loading it there would only add a failure mode. Diagnostics
 * loads it on a scratch database to prove the shipped binary actually works.
 */
export async function loadSqliteVec(db: Database.Database): Promise<string> {
  const sqliteVec = await import('sqlite-vec');
  const extensionPath = sqliteVec.getLoadablePath();
  db.loadExtension(extensionPath);
  return extensionPath;
}
