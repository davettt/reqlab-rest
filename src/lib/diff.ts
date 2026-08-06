/**
 * What changed since the last time this request was sent.
 *
 * A display-only port of `server/verify/diff.js`. The two are deliberately separate: the
 * server module is the authority — it is what reports and findings are built from, and what
 * the tests exercise — while this one only powers the Diff tab in the response pane. If they
 * ever drift, the report a PM hands to an engineer is still the correct one.
 *
 * The port exists because the frontend is TypeScript with `strict` and the server is plain
 * JS outside `include`, so there is no import path between them that does not mean turning on
 * `allowJs` for a single file.
 *
 * The rule that matters is the same in both: fields that move on every call — timestamps,
 * request ids, ETags, revision counters — are excluded. A diff that reports those is noise,
 * and noise teaches people to stop reading the diff.
 */

const VOLATILE_SUFFIX_SNAKE = /_at$/i;
const VOLATILE_SUFFIX_CAMEL = /At$/;

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

const MAX_DIFFERENCES = 50;

type Json = unknown;

function isVolatileKey(key: string): boolean {
  return (
    VOLATILE_NAME.has(key) ||
    VOLATILE_STEM.has(key.toLowerCase()) ||
    VOLATILE_SUFFIX_SNAKE.test(key) ||
    VOLATILE_SUFFIX_CAMEL.test(key)
  );
}

function isPlainObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parse(body: string | undefined): Json | undefined {
  try {
    return JSON.parse(String(body ?? '')) as Json;
  } catch {
    return undefined;
  }
}

function format(value: Json): string {
  if (value === undefined) return 'absent';
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function collect(a: Json, b: Json, path: string, out: string[]): void {
  if (out.length >= MAX_DIFFERENCES) return;

  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (isVolatileKey(key)) continue;
      collect(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push(`${path || 'the list'} held ${a.length} entries, now ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i += 1) {
      collect(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (typeof a === 'string' && typeof b === 'string' && ISO_DATE.test(a) && ISO_DATE.test(b)) {
    return;
  }

  if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path || 'the response'} was ${format(a)}, now ${format(b)}`);
  }
}

/** Plain-English descriptions of what changed. Empty when nothing meaningful did. */
export function diffBodies(previous: string | undefined, current: string | undefined): string[] {
  const a = parse(previous);
  const b = parse(current);

  if (a === undefined || b === undefined) {
    return String(previous ?? '') === String(current ?? '')
      ? []
      : ['The response body changed, and is not JSON, so it could not be compared field by field.'];
  }

  const out: string[] = [];
  collect(a, b, '', out);
  return out;
}
