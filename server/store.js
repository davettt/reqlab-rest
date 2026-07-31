/**
 * Persistence for local_data/.
 *
 * Every write goes through here, and every write is atomic (temp file + rename). The sibling
 * apps in this directory call fs.writeFile directly on their data files; because local_data/
 * sits inside a synced folder, a read-modify-write that is interrupted mid-flight produces a
 * sync conflict. crypto-tracker/local_data/ currently holds ~80 conflict copies of one file.
 * Rename is atomic on the same filesystem, so a reader sees either the old file or the new one.
 *
 * Writes are also debounced and coalesced per path: rapid edits (typing in a request name)
 * collapse into one write, and a flush is forced on shutdown so nothing in flight is lost.
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_ROOT = process.env.REQLAB_DATA_DIR
  ? path.resolve(process.env.REQLAB_DATA_DIR)
  : path.join(__dirname, '..', 'local_data');

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Resolve a path inside DATA_ROOT. Ids reach this from HTTP requests, so anything that
 * escapes the data directory is rejected rather than clamped.
 */
export function resolveDataPath(relativePath) {
  const full = path.resolve(DATA_ROOT, relativePath);
  const root = path.resolve(DATA_ROOT);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Refusing to access a path outside local_data: ${relativePath}`);
  }
  return full;
}

export async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

/* ---------------------------------------------------------------- *
 * Reads
 * ---------------------------------------------------------------- */

export async function readJson(relativePath, fallback = null) {
  const full = resolveDataPath(relativePath);
  const pending = pendingWrites.get(full);
  // Read-your-writes: a debounced value is the current truth even if it is not on disk yet.
  if (pending) return structuredClone(pending.data);
  try {
    return JSON.parse(await fsp.readFile(full, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      throw new Error(`${relativePath} is not valid JSON — it may be a sync conflict copy.`);
    }
    throw err;
  }
}

export async function listDir(relativePath) {
  try {
    return await fsp.readdir(resolveDataPath(relativePath));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function exists(relativePath) {
  try {
    await fsp.access(resolveDataPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- *
 * Writes
 * ---------------------------------------------------------------- */

/** Serialises writes per path so two flushes of the same file cannot interleave. */
const writeChains = new Map();

function chain(full, task) {
  const previous = writeChains.get(full) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    full,
    next.catch(() => {}),
  );
  return next;
}

async function atomicWrite(full, contents) {
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(contents, 'utf8');
    // fsync before rename: rename is atomic, but without this the rename can land before
    // the data does after a hard crash, leaving an empty file.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, full);
}

/** Write immediately. Prefer save() for user-driven edits. */
export function writeJson(relativePath, data) {
  const full = resolveDataPath(relativePath);
  return chain(full, () => atomicWrite(full, JSON.stringify(data, null, 2)));
}

const pendingWrites = new Map();

/** Debounced, coalesced write. Returns immediately; use flush() to await the result. */
export function save(relativePath, data, { debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const full = resolveDataPath(relativePath);
  const existing = pendingWrites.get(full);
  if (existing) {
    existing.data = data;
    return existing.promise;
  }

  let resolveFlush;
  let rejectFlush;
  const promise = new Promise((resolve, reject) => {
    resolveFlush = resolve;
    rejectFlush = reject;
  });

  const entry = { data, promise, resolveFlush, rejectFlush, timer: null };
  // Deliberately not unref'd: a pending write must keep the process alive until it lands,
  // otherwise an otherwise-idle process exits and silently drops the user's last edit.
  entry.timer = setTimeout(() => {
    void flushPath(full);
  }, debounceMs);

  pendingWrites.set(full, entry);
  return promise;
}

async function flushPath(full) {
  const entry = pendingWrites.get(full);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingWrites.delete(full);
  try {
    await chain(full, () => atomicWrite(full, JSON.stringify(entry.data, null, 2)));
    entry.resolveFlush();
  } catch (err) {
    entry.rejectFlush(err);
    throw err;
  }
}

/** Force a pending write to disk now. With no argument, flushes everything. */
export async function flush(relativePath) {
  if (relativePath) {
    await flushPath(resolveDataPath(relativePath));
    return;
  }
  await Promise.allSettled([...pendingWrites.keys()].map((full) => flushPath(full)));
  await Promise.allSettled([...writeChains.values()]);
}

export async function remove(relativePath) {
  const full = resolveDataPath(relativePath);
  const entry = pendingWrites.get(full);
  if (entry) {
    clearTimeout(entry.timer);
    pendingWrites.delete(full);
    entry.resolveFlush();
  }
  await chain(full, () => fsp.rm(full, { recursive: true, force: true }));
}

/* ---------------------------------------------------------------- *
 * Append-only logs (request history)
 * ---------------------------------------------------------------- */

/** Append one JSON line, trimming the file to maxLines when it grows past the cap. */
export async function appendLine(relativePath, entry, { maxLines = 500 } = {}) {
  const full = resolveDataPath(relativePath);
  await chain(full, async () => {
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.appendFile(full, JSON.stringify(entry) + '\n', 'utf8');

    const lines = (await fsp.readFile(full, 'utf8')).split('\n').filter(Boolean);
    if (lines.length > maxLines) {
      await atomicWrite(full, lines.slice(-maxLines).join('\n') + '\n');
    }
  });
}

/** Most recent entries first. Unparseable lines are skipped rather than throwing. */
export async function readLines(relativePath, { limit = 100 } = {}) {
  try {
    const raw = await fsp.readFile(resolveDataPath(relativePath), 'utf8');
    const lines = raw.split('\n').filter(Boolean).slice(-limit).reverse();
    const out = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line));
      } catch {
        /* truncated or conflicted line — skip */
      }
    }
    return out;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/* ---------------------------------------------------------------- *
 * Schema versioning
 * ---------------------------------------------------------------- */

/**
 * Bring a loaded document up to `targetVersion`, backing up first.
 *
 * `migrations` maps a from-version to a function producing the next version, e.g.
 * `{ 1: (doc) => ({ ...doc, schemaVersion: 2, tags: [] }) }`.
 *
 * A document newer than this build refuses to load rather than being silently downgraded —
 * an older app writing its own shape over newer data is how data actually gets destroyed.
 */
export async function migrateDocument(doc, { targetVersion, migrations, label }) {
  let current = doc?.schemaVersion ?? 1;

  if (current > targetVersion) {
    throw new Error(
      `${label} was written by a newer version of ReqLab REST (schema v${current}, this build ` +
        `understands v${targetVersion}). Update the app rather than risk overwriting the data.`,
    );
  }
  if (current === targetVersion) return doc;

  await backupBeforeMigration(current);

  let migrated = doc;
  while (current < targetVersion) {
    const step = migrations[current];
    if (!step) throw new Error(`No migration from schema v${current} for ${label}`);
    migrated = step(migrated);
    current = migrated.schemaVersion ?? current + 1;
  }
  return migrated;
}

let backupTaken = false;

/** One snapshot of local_data/ per process, kept to the last 10, before any migration runs. */
async function backupBeforeMigration(fromVersion) {
  if (backupTaken) return;
  backupTaken = true;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(DATA_ROOT, 'backups', `${stamp}-v${fromVersion}`);
  await fsp.mkdir(dest, { recursive: true });

  for (const entry of await fsp.readdir(DATA_ROOT, { withFileTypes: true })) {
    if (entry.name === 'backups') continue;
    await fsp.cp(path.join(DATA_ROOT, entry.name), path.join(dest, entry.name), {
      recursive: true,
    });
  }

  const backupsRoot = path.join(DATA_ROOT, 'backups');
  const all = (await fsp.readdir(backupsRoot)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) {
    await fsp.rm(path.join(backupsRoot, old), { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- *
 * Shutdown
 * ---------------------------------------------------------------- */

let shutdownHooked = false;

/** Flush debounced writes on exit so a pm2 restart never drops the last edit. */
export function installShutdownFlush() {
  if (shutdownHooked) return;
  shutdownHooked = true;

  const onSignal = (signal) => async () => {
    try {
      await flush();
    } catch (err) {
      console.error('[reqlab-rest] failed to flush pending writes on shutdown:', err);
    }
    process.exit(signal === 'SIGINT' ? 130 : 0);
  };

  process.once('SIGTERM', onSignal('SIGTERM'));
  process.once('SIGINT', onSignal('SIGINT'));
  process.once('exit', () => {
    // Last resort: synchronous, because async work cannot run during 'exit'.
    for (const [full, entry] of pendingWrites) {
      try {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, JSON.stringify(entry.data, null, 2), 'utf8');
      } catch {
        /* nothing useful to do while exiting */
      }
    }
  });
}
