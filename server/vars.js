/**
 * {{variable}} resolution and secret masking.
 *
 * Resolution happens here, on the server, immediately before a request is sent. The browser
 * never receives the plaintext of a secret variable — not in the request preview, not in the
 * run record, not in generated code. maskText() is the single choke point for that, so any new
 * surface that echoes request data back must run through it.
 *
 * Precedence, lowest to highest: project variables < environment variables < captured values.
 */
import { decrypt } from './crypto.js';

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;
const MAX_NESTING = 5;
export const MASK = '••••';

/**
 * Build the lookup used by every interpolate call. Secret values are decrypted here and
 * nowhere else.
 */
export function buildScope({ projectVars = [], envVars = [], captures = {} } = {}) {
  const scope = new Map();

  const add = (list) => {
    for (const v of list) {
      if (!v || !v.key || v.enabled === false) continue;
      scope.set(v.key, {
        value: v.secret ? decrypt(v.value) : (v.value ?? ''),
        secret: Boolean(v.secret),
      });
    }
  };

  add(projectVars);
  add(envVars);

  for (const [key, value] of Object.entries(captures)) {
    scope.set(key, { value: String(value ?? ''), secret: false });
  }

  return scope;
}

/**
 * Replace placeholders in a string.
 *
 * Returns the resolved text plus what was missing and which secrets were used, so callers can
 * warn about typos ("{{basUrl}}") instead of silently sending a literal "{{basUrl}}" upstream.
 */
export function interpolate(input, scope, depth = 0) {
  if (typeof input !== 'string') return { text: input, missing: [], secretsUsed: [] };

  const missing = new Set();
  const secretsUsed = new Set();

  const text = input.replace(PLACEHOLDER, (match, key) => {
    const entry = scope.get(key);
    if (!entry) {
      missing.add(key);
      return match;
    }
    if (entry.secret) secretsUsed.add(key);

    // A variable may itself reference another variable; bounded to avoid a cycle spinning.
    if (depth < MAX_NESTING && PLACEHOLDER.test(entry.value)) {
      PLACEHOLDER.lastIndex = 0;
      const nested = interpolate(entry.value, scope, depth + 1);
      nested.missing.forEach((k) => missing.add(k));
      nested.secretsUsed.forEach((k) => secretsUsed.add(k));
      return nested.text;
    }
    return entry.value;
  });

  return { text, missing: [...missing], secretsUsed: [...secretsUsed] };
}

/** Interpolate every string in a nested structure, accumulating what was missing. */
export function interpolateDeep(value, scope) {
  const missing = new Set();
  const secretsUsed = new Set();

  const walk = (node) => {
    if (typeof node === 'string') {
      const r = interpolate(node, scope);
      r.missing.forEach((k) => missing.add(k));
      r.secretsUsed.forEach((k) => secretsUsed.add(k));
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [walk(k), walk(v)]));
    }
    return node;
  };

  return { value: walk(value), missing: [...missing], secretsUsed: [...secretsUsed] };
}

/**
 * Replace every resolved secret value with the mask.
 *
 * Deliberately value-based rather than key-based: once a secret has been substituted into a
 * URL, header, or response echo, the key is gone and only the value can be found. Longest
 * values are masked first so a secret that contains another secret cannot leave a fragment.
 */
export function maskText(text, scope) {
  if (typeof text !== 'string' || !text) return text;

  const secrets = [...scope.values()]
    .filter((entry) => entry.secret && entry.value && entry.value.length >= 4)
    .map((entry) => entry.value)
    .sort((a, b) => b.length - a.length);

  let out = text;
  for (const secret of secrets) out = out.split(secret).join(MASK);
  return out;
}

/** maskText over a nested structure — used on run records before they are stored or returned. */
export function maskDeep(value, scope) {
  if (typeof value === 'string') return maskText(value, scope);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, scope)]));
  }
  return value;
}

/** The variable names referenced by a template, for "this request needs X" hints in the UI. */
export function referencedVars(input) {
  if (typeof input !== 'string') return [];
  const names = new Set();
  for (const match of input.matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}
