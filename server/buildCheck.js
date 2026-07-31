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
      if (entry.isDirectory()) {
        newest = Math.max(newest, newestMtime(full));
      } else {
        if (entry.name.endsWith('.log')) continue;
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  } catch {
    /* directory doesn't exist */
  }
  return newest;
}

let _stale = false;

try {
  const buildTime = parseInt(fs.readFileSync(path.join(ROOT, '.last-build'), 'utf8'), 10);
  const srcTime = Math.max(
    newestMtime(path.join(ROOT, 'src')),
    newestMtime(path.join(ROOT, 'server')),
  );
  _stale = srcTime > buildTime;
  if (_stale) {
    console.warn('Build is stale — source changed since last build. Run: npm run restart:pm2');
  }
} catch {
  _stale = false;
}

export const buildStale = _stale;
