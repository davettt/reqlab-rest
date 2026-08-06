/**
 * Latency: is this endpoint slower than it used to be?
 *
 * Explicitly not load testing — that lives in the rate-limit lab. This sends a handful of
 * sequential requests, takes the percentiles, and compares them against a baseline saved from
 * an earlier run. The question it answers is "did something regress", not "how much can it
 * take", and the two need different tools: a single client sending twelve requests one after
 * another measures the service, while anything concurrent starts measuring the queue.
 *
 * Two deliberate limits:
 *
 *  - **Only safe methods.** Sending a POST twelve times to measure it creates twelve records.
 *    GET, HEAD and OPTIONS are repeatable by definition; everything else is reported as not
 *    measured rather than quietly skipped.
 *  - **The first response is discarded.** It pays for DNS, the TCP handshake and TLS, and on
 *    a cold service the first request also warms caches and connection pools. Including it
 *    makes every endpoint look slow and every second run look like an improvement.
 */
import { finding, evidenceFrom } from './findings.js';

const SUITE = 'latency';

const SAMPLES = 12;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A regression has to be both proportionally and absolutely large to be worth reporting.
 *
 * Ratio alone flags 2ms becoming 6ms, which is noise on any real network. Absolute alone
 * flags a slow endpoint that has not changed. Requiring both is what keeps the report free of
 * findings nobody can act on.
 */
const REGRESSION_RATIO = 2;
const SEVERE_RATIO = 4;
const REGRESSION_FLOOR_MS = 50;

/**
 * @param {object} args
 * @param {Function} args.send       async (request) => sanitised run record
 * @param {object[]} args.requests   the requests to measure
 * @param {object} [args.baseline]   a previously saved { measurements: {...} }
 * @returns {Promise<{ findings: object[], measurements: object }>}
 */
export async function runLatency({ send, requests, baseline = null }) {
  const findings = [];
  const measurements = {};
  const unmeasurable = [];

  for (const request of requests) {
    const method = (request.method ?? 'GET').toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      unmeasurable.push(label(request));
      continue;
    }

    const measured = await measure({ send, request });
    if (!measured) continue;

    measurements[label(request)] = measured.stats;

    const previous = baseline?.measurements?.[label(request)];
    if (previous) {
      compare({ findings, request, current: measured.stats, previous, run: measured.lastRun });
    }
  }

  if (!Object.keys(measurements).length) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: 'Nothing could be timed',
        whatHappened: unmeasurable.length
          ? `The project's requests all use methods that change data (${unmeasurable
              .slice(0, 5)
              .join(', ')}${unmeasurable.length > 5 ? ', …' : ''}), so repeating them to take ` +
            'a measurement was not safe.'
          : 'No request returned a response that could be timed.',
        whyItMatters:
          'This is not a pass. Latency is measured on GET, HEAD and OPTIONS only, because ' +
          'those are the methods that can be repeated without side effects. Add a read ' +
          'request to measure this API.',
        expected: 'at least one GET request',
        actual: 'none',
      }),
    );
    return { findings, measurements };
  }

  if (!baseline) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: 'Latency baseline recorded',
        whatHappened:
          `Timed ${Object.keys(measurements).length} endpoint` +
          `${Object.keys(measurements).length === 1 ? '' : 's'} over ${SAMPLES} requests each: ` +
          summariseMeasurements(measurements),
        whyItMatters:
          'There was nothing to compare against, so this run becomes the baseline. Later runs ' +
          'are measured against it, and a slowdown is reported as a finding. The percentiles ' +
          `come from ${SAMPLES} samples, so read p50 as reliable and p99 as indicative.`,
        expected: 'a baseline to compare against',
        actual: 'none yet — this run is now the baseline',
      }),
    );
  }

  if (unmeasurable.length && Object.keys(measurements).length) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: `${unmeasurable.length} request${unmeasurable.length === 1 ? ' was' : 's were'} not timed`,
        whatHappened:
          `${unmeasurable.slice(0, 5).join(', ')}${unmeasurable.length > 5 ? ', …' : ''} ` +
          'change data, so they were not repeated.',
        whyItMatters:
          'Their timings are not in this report and not in the baseline. A write that gets ' +
          'slower will not be caught here.',
        expected: null,
        actual: `${unmeasurable.length} not measured`,
      }),
    );
  }

  return { findings, measurements };
}

/* ---------------------------------------------------------------- *
 * Measurement
 * ---------------------------------------------------------------- */

async function measure({ send, request }) {
  const warmUp = await safeSend(send, request);
  if (!warmUp) return null;

  const samples = [];
  let lastRun = warmUp;

  for (let i = 0; i < SAMPLES; i += 1) {
    const run = await safeSend(send, request);
    if (!run) continue;

    lastRun = run;
    const total = run.timing?.totalMs;
    if (typeof total === 'number' && Number.isFinite(total)) samples.push(total);
  }

  if (samples.length < 3) return null;

  return { stats: statsOf(samples), lastRun };
}

/**
 * Nearest-rank percentiles.
 *
 * No interpolation: with a dozen samples, interpolating invents precision the measurement does
 * not have. The rank picks an observation that actually happened.
 */
function statsOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

  return {
    samples: sorted.length,
    min: round(sorted[0]),
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
  };
}

function round(ms) {
  return Math.round(ms * 10) / 10;
}

/* ---------------------------------------------------------------- *
 * Comparison against the baseline
 * ---------------------------------------------------------------- */

function compare({ findings, request, current, previous, run }) {
  const endpoint = label(request);
  const before = previous.p95;
  const after = current.p95;

  if (typeof before !== 'number' || !before) return;

  const ratio = after / before;
  const delta = after - before;

  if (ratio < REGRESSION_RATIO || delta < REGRESSION_FLOOR_MS) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: ratio >= SEVERE_RATIO ? 'major' : 'minor',
      endpoint,
      title: `${endpoint} is ${ratio.toFixed(1)}× slower than the baseline`,
      whatHappened:
        `The 95th-percentile response time was ${before}ms when the baseline was recorded and ` +
        `is ${after}ms now — ${Math.round(delta)}ms slower. The median moved from ` +
        `${previous.p50}ms to ${current.p50}ms.`,
      whyItMatters:
        'Something between the two runs made this endpoint materially slower. Latency ' +
        'regressions rarely announce themselves: the endpoint still returns the right answer, ' +
        'so nothing fails, and the cost lands on whatever calls it. The usual causes are a ' +
        'query that lost its index, an added lookup inside a loop, or a new synchronous call ' +
        'to another service.',
      expected: `about ${before}ms at p95`,
      actual: `${after}ms at p95`,
      evidence: evidenceFrom(run),
    }),
  );
}

function summariseMeasurements(measurements) {
  return Object.entries(measurements)
    .slice(0, 4)
    .map(([endpoint, stats]) => `${endpoint} p50 ${stats.p50}ms / p95 ${stats.p95}ms`)
    .join(', ');
}

/* ---------------------------------------------------------------- *
 * Shared helpers
 * ---------------------------------------------------------------- */

async function safeSend(send, request) {
  try {
    return await send(request);
  } catch {
    return null;
  }
}

function label(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '');
  return `${request.method} ${path}`;
}
