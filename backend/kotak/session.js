// In-memory session store — one active login at a time per server process.
// For multi-user production you'd use Redis or a database.

const sessions = new Map();

const DEFAULT_KEY = "default";

export function setSession(data, key = DEFAULT_KEY) {
  sessions.set(key, { ...data, updatedAt: Date.now() });
}

export function getSession(key = DEFAULT_KEY) {
  return sessions.get(key) || null;
}

export function clearSession(key = DEFAULT_KEY) {
  sessions.delete(key);
}

export function hasActiveSession(key = DEFAULT_KEY) {
  const s = sessions.get(key);
  if (!s) return false;
  // Expire after 30 minutes
  return Date.now() - s.updatedAt < 30 * 60 * 1000;
}
