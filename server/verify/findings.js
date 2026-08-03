/**
 * The finding model.
 *
 * Every verification suite emits these and nothing else, and both report formats render only
 * these. That constraint is the point: a finding is something you hand to the engineer who
 * wrote the API, so it must carry the evidence that produced it, not just an opinion.
 *
 * Two rules follow from that:
 *
 *  - Plain English. The reader may be a PM writing a ticket, not the person who knows what
 *    "422 on unknown discriminator" means.
 *  - Every finding names what it expected, what it got, and the exact request and response.
 *    A claim without evidence is an argument; a claim with evidence is a bug report.
 */

export const SEVERITIES = ['blocker', 'major', 'minor', 'info'];

const RANK = { blocker: 0, major: 1, minor: 2, info: 3 };

/**
 * @param {object} input
 * @param {string} input.suite        which suite found it
 * @param {string} input.severity     blocker | major | minor | info
 * @param {string} input.title        one line, names the endpoint and the problem
 * @param {string} input.whatHappened plain English, no jargon
 * @param {string} input.whyItMatters the consequence, for a mixed audience
 * @param {*} input.expected
 * @param {*} input.actual
 * @param {object} [input.evidence]   { request, response, timingMs } — already sanitised
 * @param {string} [input.specRef]    OpenAPI pointer, when the check came from a spec
 */
export function finding({
  suite,
  severity,
  title,
  whatHappened,
  whyItMatters,
  expected,
  actual,
  evidence,
  specRef,
  endpoint,
}) {
  if (!SEVERITIES.includes(severity)) {
    throw new Error(`Unknown severity "${severity}" in ${suite}`);
  }

  return {
    id: `${suite}:${endpoint ?? title}`.slice(0, 300),
    suite,
    severity,
    title,
    whatHappened,
    whyItMatters,
    expected: expected ?? null,
    actual: actual ?? null,
    endpoint: endpoint ?? null,
    specRef: specRef ?? null,
    evidence: evidence ?? null,
  };
}

/** Most severe first, then by suite, so a report reads worst-first. */
export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => RANK[a.severity] - RANK[b.severity] || a.suite.localeCompare(b.suite),
  );
}

export function summarise(findings) {
  const counts = { blocker: 0, major: 0, minor: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;

  return {
    total: findings.length,
    ...counts,
    // "Passed" means nothing worse than info. Minor issues are real and still reported, but
    // they should not make a run read as failed.
    passed: counts.blocker === 0 && counts.major === 0 && counts.minor === 0,
  };
}

/**
 * Reduce a run record to what a report should show.
 *
 * Deliberately lossy: a full run record carries the entire response body, which makes a
 * report enormous and buries the finding. The body is truncated, and the caller has already
 * masked secrets via sanitiseRun.
 */
export function evidenceFrom(run, { maxBodyChars = 2000 } = {}) {
  if (!run) return null;

  const body = run.response?.body ?? '';
  const truncated = body.length > maxBodyChars;

  return {
    request: {
      method: run.request?.method,
      url: run.request?.url,
      headers: run.request?.headers ?? {},
      body: run.request?.body?.text ? String(run.request.body.text).slice(0, maxBodyChars) : '',
    },
    response: {
      status: run.response?.status,
      statusText: run.response?.statusText,
      headers: run.response?.headers ?? {},
      body: truncated ? body.slice(0, maxBodyChars) + '\n… truncated' : body,
    },
    timingMs: run.timing?.totalMs ?? null,
  };
}
