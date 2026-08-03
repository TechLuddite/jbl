/**
 * Persistence.
 *
 * Currently localStorage, which means league data lives in ONE browser on ONE
 * device. That is a deliberate v1 choice, not an oversight — see ROADMAP.md.
 *
 * Everything is async so that swapping in a real backend later is a change to
 * this file only, with no call-site churn.
 */

const PREFIX = "jbl:";

export async function get(key, fallback = null) {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function set(key, value) {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded or storage disabled. The session still works in memory.
    return false;
  }
}

export async function remove(key) {
  try {
    window.localStorage.removeItem(PREFIX + key);
    return true;
  } catch {
    return false;
  }
}

/** Dump every jbl key as one object — used by the export button. */
export async function exportAll() {
  const out = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(PREFIX)) {
      out[k.slice(PREFIX.length)] = JSON.parse(window.localStorage.getItem(k));
    }
  }
  return out;
}

/** Restore from an exported object. Overwrites matching keys. */
export async function importAll(data) {
  for (const [k, v] of Object.entries(data ?? {})) await set(k, v);
}
