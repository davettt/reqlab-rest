/**
 * Idempotency: what happens when the same request arrives twice?
 *
 * It arrives twice more often than people expect — a retry after a timeout, a double-clicked
 * button, a queue redelivering a message. HTTP is explicit that PUT and DELETE must be safe to
 * repeat, and the failure mode when they are not is quiet: the first call succeeded, the retry
 * also returned 200, and the resource is now in a state nobody asked for. A PUT written as
 * "increment" rather than "set" is the classic example.
 *
 * This suite genuinely repeats writes, which is why it is gated behind the same authorisation
 * acknowledgement as the other intrusive suites. It is deliberately narrow about POST: sending
 * one twice creates two records, so that is only done when the request already carries an
 * Idempotency-Key, which is the API claiming it handles exactly this case.
 */
import { finding, evidenceFrom } from './findings.js';
import { diffBodies, describeDifferences } from './diff.js';

const SUITE = 'idempotency';

/**
 * @param {object} args
 * @param {Function} args.send        async (request) => sanitised run record
 * @param {Function} [args.session]   () => a send whose variable scope is fixed, so a repeated
 *                                    request resolves {{$uuid}} and friends to the same value.
 *                                    Without it the "repeat" is a different request.
 * @param {object[]} args.requests    the requests to probe
 */
export async function runIdempotency({ send, session = () => send, requests }) {
  const findings = [];
  let probed = 0;

  for (const request of requests) {
    const method = (request.method ?? 'GET').toUpperCase();

    if (method === 'PUT') {
      probed += 1;
      await checkRepeatablePut({ findings, send: session(), request });
    } else if (method === 'DELETE') {
      probed += 1;
      await checkRepeatableDelete({ findings, send: session(), request });
    } else if (method === 'POST' && idempotencyKeyOf(request)) {
      probed += 1;
      await checkIdempotencyKey({ findings, send: session(), request });
    }
  }

  if (probed === 0) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: 'Nothing was repeatable to test',
        whatHappened:
          'The project contains no PUT or DELETE requests, and no POST carrying an ' +
          'Idempotency-Key header.',
        whyItMatters:
          'This is not a pass. Add a PUT or DELETE request, or an Idempotency-Key header to a ' +
          'create, so retry behaviour can be checked.',
        expected: 'at least one repeatable request',
        actual: 'none',
      }),
    );
  }

  return findings;
}

/* ---------------------------------------------------------------- *
 * PUT — the same request twice must leave the same state
 * ---------------------------------------------------------------- */

async function checkRepeatablePut({ findings, send, request }) {
  const first = await safeSend(send, request);
  if (!first || first.response.status >= 400) return;

  const second = await safeSend(send, request);
  if (!second) return;

  const endpoint = label(request);

  if (second.response.status !== first.response.status) {
    findings.push(
      finding({
        suite: SUITE,
        severity: second.response.status >= 500 ? 'blocker' : 'major',
        endpoint,
        title: `${endpoint} answers differently the second time`,
        whatHappened:
          `The identical request returned ${first.response.status}, then ` +
          `${second.response.status}.`,
        whyItMatters:
          'PUT is defined as repeatable, so a client that retries after a timeout expects the ' +
          'same answer. A different status means the retry is treated as a new, different ' +
          'operation — and the client cannot tell whether its first attempt took effect.',
        expected: `${first.response.status} again`,
        actual: String(second.response.status),
        evidence: evidenceFrom(second),
      }),
    );
    return;
  }

  const difference = describeDifferences(diffBodies(first.response.body, second.response.body));
  if (!difference) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'major',
      endpoint,
      title: `${endpoint} is not idempotent — repeating it changes the result`,
      whatHappened: `Sending the identical request twice produced different responses. ${difference}`,
      whyItMatters:
        'PUT must set a value, not modify it relative to what is already there. Because it ' +
        'does not, any retry — after a network timeout, a double-clicked button, a redelivered ' +
        'queue message — applies the change a second time. The client sees success both times ' +
        'and has no way to detect the duplicate.',
      expected: 'the same response both times',
      actual: difference,
      evidence: evidenceFrom(second),
    }),
  );
}

/* ---------------------------------------------------------------- *
 * DELETE — deleting twice must not fall over
 * ---------------------------------------------------------------- */

async function checkRepeatableDelete({ findings, send, request }) {
  const first = await safeSend(send, request);
  if (!first || first.response.status >= 400) return;

  const second = await safeSend(send, request);
  if (!second) return;

  const endpoint = label(request);
  const status = second.response.status;

  // 404 and "the same success again" are both defensible readings of the spec. A 5xx is not:
  // it means the handler assumed the resource was there.
  if (status < 500 && (status === first.response.status || status === 404 || status === 410)) {
    return;
  }

  findings.push(
    finding({
      suite: SUITE,
      severity: status >= 500 ? 'blocker' : 'minor',
      endpoint,
      title:
        status >= 500
          ? `${endpoint} fails when the same thing is deleted twice`
          : `${endpoint} answers a repeated delete inconsistently`,
      whatHappened: `The first delete returned ${first.response.status} and the second returned ${status}.`,
      whyItMatters:
        status >= 500
          ? 'A retry after a timeout — which the client cannot distinguish from a genuine ' +
            'failure — produces a server error. The client then reports the deletion as failed ' +
            'when it actually succeeded, and a user is told their action did not work.'
          : 'Deleting something already deleted should settle on one answer, either the same ' +
            'success or 404. An unexpected third status makes retry logic guesswork.',
      expected: `${first.response.status} again, or 404`,
      actual: String(status),
      evidence: evidenceFrom(second),
    }),
  );
}

/* ---------------------------------------------------------------- *
 * POST + Idempotency-Key — the key must actually collapse the retry
 * ---------------------------------------------------------------- */

async function checkIdempotencyKey({ findings, send, request }) {
  const first = await safeSend(send, request);
  if (!first || first.response.status >= 400) return;

  const second = await safeSend(send, request);
  if (!second) return;

  const endpoint = label(request);
  const firstId = resourceIdOf(first);
  const secondId = resourceIdOf(second);

  if (firstId === null || secondId === null) return;
  if (firstId === secondId) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'blocker',
      endpoint,
      title: `${endpoint} ignores its Idempotency-Key`,
      whatHappened:
        `The same request was sent twice with the same Idempotency-Key and created two ` +
        `different resources: ${firstId} and ${secondId}.`,
      whyItMatters:
        'The header exists so a client can retry a create safely. Because it is not honoured, ' +
        'every retry creates a duplicate — a second order, a second charge, a second record — ' +
        'and the client believes it made one request.',
      expected: 'the same resource returned twice',
      actual: `${firstId} then ${secondId}`,
      evidence: evidenceFrom(second),
    }),
  );
}

function idempotencyKeyOf(request) {
  const header = (request.headers ?? []).find(
    (h) => h.enabled !== false && /^idempotency[-_]key$/i.test(String(h.key ?? '')),
  );
  return header?.value ?? null;
}

function resourceIdOf(run) {
  const location = run.response.headers?.location;
  if (location) return String(location);

  const body = parse(run.response.body);
  if (!body) return null;

  for (const key of ['id', 'uuid', '_id', 'guid', 'reference']) {
    const value = body[key];
    if (typeof value === 'string' || typeof value === 'number') return `${key}=${value}`;
  }
  return null;
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

function parse(body) {
  try {
    const value = JSON.parse(String(body ?? ''));
    return value !== null && typeof value === 'object' ? value : null;
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
