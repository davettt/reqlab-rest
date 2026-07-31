import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

/** Random high port, so tests never collide with the pm2 instance on 3016. */
export function randomPort() {
  return 34000 + Math.floor(Math.random() * 10000);
}

/**
 * Spawn a server instance and wait until it answers. Tests are hermetic: they never
 * depend on the pm2 process being up, which also lets them run in CI.
 */
export async function startServer({
  port = randomPort(),
  env = {},
  script = 'server/index.js',
} = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (code ${child.exitCode}):\n${log}`);
    }
    try {
      const res = await fetch(`${base}/api/build-status`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`Server did not start within 15s:\n${log}`);
    }
    await sleep(100);
  }

  return {
    port,
    base,
    get log() {
      return log;
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await once(child, 'exit', 5000).catch(() => child.kill('SIGKILL'));
    },
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function once(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Minimal assertion harness — no test framework dependency.
 * ------------------------------------------------------------------ */

const results = { passed: 0, failed: [] };

export async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    results.failed.push({ name, err });
    console.error(`  \u2717 ${name}\n      ${err.message}`);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? 'not equal'}: expected ${expected}, got ${actual}`);
  }
}

export function summarise(label) {
  const { passed, failed } = results;
  if (failed.length) {
    console.error(`\n${label}: ${passed} passed, ${failed.length} FAILED`);
    process.exit(1);
  }
  console.log(`\n${label}: ${passed} passed`);
  process.exit(0);
}
