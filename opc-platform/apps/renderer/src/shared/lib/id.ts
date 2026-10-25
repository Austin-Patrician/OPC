let counter = 0;

/** Collision-safe id for optimistic UI nodes (client-only, never a database key). */
export function createId(prefix = 'id'): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** `14:05` in the user's locale-independent 24h form, matching the design. */
export function formatClock(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
