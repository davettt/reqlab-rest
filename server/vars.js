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

      let value = v.value ?? '';
      let error = null;
      if (v.secret) {
        try {
          value = decrypt(v.value);
        } catch (err) {
          // Recorded per variable rather than thrown: one secret encrypted on another
          // machine must not make every other variable in the environment unusable.
          value = '';
          error = err.message;
        }
      }

      scope.set(v.key, { value, secret: Boolean(v.secret), error });
    }
  };

  add(projectVars);
  add(envVars);

  for (const [key, capture] of Object.entries(captures)) {
    // A capture can hold a token pulled out of a login response, so it must be able to carry
    // the secret flag — otherwise maskText would never redact it.
    const isWrapped = capture && typeof capture === 'object' && 'value' in capture;
    scope.set(key, {
      value: String((isWrapped ? capture.value : capture) ?? ''),
      secret: isWrapped ? Boolean(capture.secret) : false,
      error: null,
    });
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
  if (typeof input !== 'string') return { text: input, missing: [], secretsUsed: [], errors: [] };

  const missing = new Set();
  const secretsUsed = new Set();
  const errors = new Set();

  const text = input.replace(PLACEHOLDER, (match, key) => {
    const entry = scope.get(key);
    if (!entry) {
      missing.add(key);
      return match;
    }
    // Surfaced only when the broken variable is actually referenced.
    if (entry.error) errors.add(`${key}: ${entry.error}`);
    if (entry.secret) secretsUsed.add(key);

    // A variable may itself reference another variable; bounded to avoid a cycle spinning.
    PLACEHOLDER.lastIndex = 0;
    const isNested = PLACEHOLDER.test(entry.value);
    PLACEHOLDER.lastIndex = 0;

    if (isNested && depth >= MAX_NESTING) {
      // Report rather than return a value still containing placeholders, which would be
      // sent upstream looking like a resolved value.
      errors.add(`${key}: variable nesting is deeper than ${MAX_NESTING} levels`);
      return match;
    }

    if (isNested) {
      const nested = interpolate(entry.value, scope, depth + 1);
      nested.missing.forEach((k) => missing.add(k));
      nested.secretsUsed.forEach((k) => secretsUsed.add(k));
      nested.errors.forEach((e) => errors.add(e));
      return nested.text;
    }
    return entry.value;
  });

  return { text, missing: [...missing], secretsUsed: [...secretsUsed], errors: [...errors] };
}

/** Interpolate every string in a nested structure, accumulating what was missing. */
export function interpolateDeep(value, scope) {
  const missing = new Set();
  const secretsUsed = new Set();
  const errors = new Set();

  const walk = (node) => {
    if (typeof node === 'string') {
      const r = interpolate(node, scope);
      r.missing.forEach((k) => missing.add(k));
      r.secretsUsed.forEach((k) => secretsUsed.add(k));
      r.errors.forEach((e) => errors.add(e));
      return r.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [walk(k), walk(v)]));
    }
    return node;
  };

  return {
    value: walk(value),
    missing: [...missing],
    secretsUsed: [...secretsUsed],
    errors: [...errors],
  };
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
    // Two different secret keys can mask to the same string; without disambiguation
    // Object.fromEntries would silently drop all but the last value.
    const used = new Set();
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => {
        const base = maskText(k, scope);
        let key = base;
        let n = 2;
        while (used.has(key)) key = `${base} (${n++})`;
        used.add(key);
        return [key, maskDeep(v, scope)];
      }),
    );
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
