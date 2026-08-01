import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'local_data', '.git']);

function newestMtime(dir) {
  let newest = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // nosemgrep: path-join-resolve-traversal — entry.name comes from readdirSync, not user input
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          newest = Math.max(newest, newestMtime(full));
        } else {
          if (entry.name.endsWith('.log')) continue;
          newest = Math.max(newest, fs.statSync(full).mtimeMs);
        }
      } catch {
        // A broken symlink or a file deleted mid-scan must not abandon the whole walk —
        // that would silently under-report the newest mtime and hide a stale build.
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return newest;
}

let _stale = false;

try {
  const raw = fs.readFileSync(path.join(ROOT, '.last-build'), 'utf8');
  const buildTime = parseInt(raw, 10);

  if (!Number.isFinite(buildTime)) {
    // A corrupt marker means the build state is unknown, and unknown must report stale.
    // Reporting fresh is how a stale build gets served with nobody noticing — note this
    // cannot throw, because the catch below would turn it back into "fresh".
    _stale = true;
    console.warn('.last-build is unreadable — treating the build as stale.');
  } else {
    const srcTime = Math.max(
      newestMtime(path.join(ROOT, 'src')),
      newestMtime(path.join(ROOT, 'server')),
    );
    _stale = srcTime > buildTime;
    if (_stale) {
      console.warn('Build is stale — source changed since last build. Run: npm run restart:pm2');
    }
  }
} catch {
  // No marker at all: a fresh checkout that has never been built, or dev mode. Not stale.
  _stale = false;
}

export const buildStale = _stale;
