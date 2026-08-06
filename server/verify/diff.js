/**
 * Structural comparison of two responses, ignoring the parts that are supposed to differ.
 *
 * Three callers want the same thing and would otherwise each grow their own half-version:
 * the idempotency suite comparing a request against its own repeat, the regression check
 * comparing today's scenario run against the last one, and the response pane showing what
 * changed since the previous send.
 *
 * The load-bearing idea is the volatile-key list. Every real API returns something that moves
 * on each call — a timestamp, a request id, an ETag, a revision counter — and a diff that
 * reports those is noise that trains people to ignore the diff. Anything in that list is
 * excluded, and the exclusion is deliberately visible here rather than buried in a caller.
 */

/** Keys whose value is expected to differ between two otherwise identical responses. */
const VOLATILE_SUFFIX_SNAKE = /_at$/i; // created_at, updated_at
const VOLATILE_SUFFIX_CAMEL = /At$/; // createdAt, updatedAt

const VOLATILE_STEM = new Set([
  'updated',
  'modified',
  'changed',
  'accessed',
  'seen',
  'synced',
  'lastseen',
  'lastmodified',
]);

const VOLATILE_NAME = new Set([
  'timestamp',
  'time',
  'now',
  'requestId',
  'request_id',
  'traceId',
  'trace_id',
  'etag',
  'version',
  'revision',
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Matched with simple tests rather than one regular expression: a single pattern covering all
 * the shapes needs nested optional groups, which is exactly the construction that backtracks
 * badly. Response keys come from the API under test, so they are untrusted input here.
 */
export function isVolatileKey(key) {
  const name = String(key);
  return (
    VOLATILE_NAME.has(name) ||
    VOLATILE_STEM.has(name.toLowerCase()) ||
    VOLATILE_SUFFIX_SNAKE.test(name) ||
    VOLATILE_SUFFIX_CAMEL.test(name)
  );
}

/**
 * Compare two response bodies.
 *
 * @param {string} firstBody
 * @param {string} secondBody
 * @param {object} [options]
 * @param {number} [options.max] stop after this many differences
 * @returns {string[]} plain-English descriptions, empty when nothing meaningful changed
 */
export function diffBodies(firstBody, secondBody, { max = 20 } = {}) {
  const a = parse(firstBody);
  const b = parse(secondBody);

  // Not JSON on one or both sides: fall back to an exact comparison, since there is no
  // structure to walk and a character-level diff would be worse than useless in a report.
  if (a === undefined || b === undefined) {
    const first = String(firstBody ?? '');
    const second = String(secondBody ?? '');
    return first === second ? [] : ['The response bodies were not identical.'];
  }

  const differences = [];
  collect(a, b, '', differences, max);
  return differences;
}

/** One sentence describing what `diffBodies` returned, or null when nothing changed. */
export function describeDifferences(differences, { show = 3 } = {}) {
  if (!differences.length) return null;

  const shown = differences.slice(0, show).join('; ');
  return differences.length > show
    ? `${shown}; and ${differences.length - show} more field(s) differed.`
    : `${shown}.`;
}

function collect(a, b, path, out, max) {
  if (out.length >= max) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (isVolatileKey(key)) continue;
      collect(a[key], b[key], path ? `${path}.${key}` : key, out, max);
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path || 'the list'} held ${a.length} entries, then ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i += 1) {
      collect(a[i], b[i], `${path}[${i}]`, out, max);
    }
    return;
  }

  // Two timestamps under a key not on the volatile list still differ because time passed.
  if (typeof a === 'string' && typeof b === 'string' && ISO_DATE.test(a) && ISO_DATE.test(b)) {
    return;
  }

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path || 'the response'} was ${format(a)}, then ${format(b)}`);
  }
}

function parse(body) {
  try {
    return JSON.parse(String(body ?? ''));
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function format(value) {
  if (value === undefined) return 'absent';
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
