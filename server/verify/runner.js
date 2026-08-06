/**
 * Runs the verification suites and assembles the result.
 *
 * Two things this owns beyond dispatch:
 *
 *  - Safety. These suites send deliberately malformed requests, replay them as other users,
 *    and probe endpoints with credentials removed. That is fine against your own API and
 *    rude-to-illegal against someone else's, so a non-loopback target requires an explicit
 *    acknowledgement from the caller.
 *  - Honesty about coverage. A suite that could not run is reported as not run, never as
 *    passing. "No findings" and "not tested" look identical in a summary otherwise.
 */
import { runContract } from './contract.js';
import { runNegative } from './negative.js';
import { runAuthz } from './authz.js';
import { runPagination } from './pagination.js';
import { runIdempotency } from './idempotency.js';
import { runCaching } from './caching.js';
import { runLatency } from './latency.js';
import { sortFindings, summarise } from './findings.js';
import { executeRequest, sanitiseRun } from '../exec/run.js';
import { buildScope } from '../vars.js';

export const SUITES = [
  'contract',
  'negative',
  'authz',
  'pagination',
  'idempotency',
  'caching',
  'latency',
];

/**
 * Suites that do something a normal caller would not.
 *
 * Contract, pagination and caching are deliberately absent: they send the documented requests,
 * walk pages, and re-request with a conditional header — all things any consumer of the API
 * does anyway. Checking whether a third-party API matches its own published documentation is a
 * legitimate thing to do without owning it.
 *
 * Latency is absent for the same reason, having been built to only ever repeat safe methods.
 *
 * The rest are different in kind. Negative testing sends malformed and oversized bodies, the
 * authorisation probes replay requests with credentials removed or swapped, and idempotency
 * repeats writes — a second PUT, a second DELETE, a second create. Repeating a write against
 * someone else's system changes their data, so it needs the acknowledgement.
 */
const INTRUSIVE_SUITES = ['negative', 'authz', 'idempotency'];

export class VerifyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VerifyError';
    this.status = 400;
  }
}

/**
 * @param {object} args
 * @param {object[]} args.requests    the requests to verify
 * @param {object} [args.spec]        parsed OpenAPI, required by the contract suite
 * @param {string[]} args.suites      which suites to run
 * @param {object[]} args.identities  [{ name, variables }] — two enable cross-user checks
 * @param {object[]} args.projectVars project-level variables
 * @param {boolean} args.acknowledged the caller owns or is authorised to test the target
 * @param {object} [args.latencyBaseline] previously saved timings to diff this run against
 */
export async function runVerification({
  requests,
  spec,
  suites = SUITES,
  identities = [],
  projectVars = [],
  acknowledged = false,
  latencyBaseline = null,
}) {
  if (!requests?.length) throw new VerifyError('There are no requests to verify.');

  const primary = identities[0] ?? { name: 'default', variables: [] };
  const scopeFor = (identity) => buildScope({ projectVars, envVars: identity?.variables ?? [] });

  assertRequestsResolve({ requests, scope: scopeFor(primary) });

  const intrusive = suites.filter((s) => INTRUSIVE_SUITES.includes(s));
  if (intrusive.length) {
    assertTargetAllowed({ requests, scope: scopeFor(primary), acknowledged, intrusive });
  }

  const send = async (request) => {
    const scope = scopeFor(primary);
    return sanitiseRun(await executeRequest(request, { scope }), scope);
  };

  /**
   * A sender whose variable scope is fixed for its lifetime.
   *
   * The idempotency suite sends the same request twice and compares the results, which only
   * means anything if the two sends are genuinely identical. Generated variables — {{$uuid}}
   * above all — resolve afresh on every scope build, so the default `send` would give the
   * repeat a different Idempotency-Key. The suite would then see two creates and report that
   * the key was ignored, against an API handling it correctly. A retry reuses its resolved
   * values by definition; this is what makes the repeat a retry rather than a new request.
   */
  const session = () => {
    const scope = scopeFor(primary);
    return async (request) => sanitiseRun(await executeRequest(request, { scope }), scope);
  };

  /**
   * Send a request as another identity.
   *
   * Only the *credentials* are swapped: everything else — ids, paths, query values — stays as
   * the primary identity's. This is the whole point of the IDOR test. Swapping the entire
   * environment would also swap the resource id, so the second user would be asking for their
   * own resource, which is allowed, and the check would silently pass while testing nothing.
   */
  const sendAs = async (name, request) => {
    const identity = identities.find((i) => i.name === name);

    const envVars = identity
      ? mergeCredentials(primary.variables ?? [], identity.variables ?? [])
      : (primary.variables ?? []);

    const scope = buildScope({ projectVars, envVars });
    // A null identity means "send with no credentials at all" — the unauthenticated probe.
    // The request's own auth is stripped by the caller.
    return sanitiseRun(await executeRequest(request, { scope }), scope);
  };

  const startedAt = Date.now();
  const findings = [];
  const ran = [];
  const skipped = [];

  if (suites.includes('contract')) {
    if (!spec) {
      skipped.push({
        suite: 'contract',
        reason:
          'No OpenAPI specification was provided. Contract conformance compares live ' +
          'responses against a spec, so it cannot run without one.',
      });
    } else {
      findings.push(...(await runContract({ spec, send, requests })));
      ran.push('contract');
    }
  }

  if (suites.includes('negative')) {
    findings.push(...(await runNegative({ send, requests })));
    ran.push('negative');
  }

  if (suites.includes('authz')) {
    findings.push(
      ...(await runAuthz({ sendAs, requests, identities: identities.map((i) => i.name) })),
    );
    ran.push('authz');
  }

  if (suites.includes('pagination')) {
    findings.push(...(await runPagination({ send, requests })));
    ran.push('pagination');
  }

  if (suites.includes('idempotency')) {
    findings.push(...(await runIdempotency({ send, session, requests })));
    ran.push('idempotency');
  }

  if (suites.includes('caching')) {
    findings.push(...(await runCaching({ send, requests })));
    ran.push('caching');
  }

  // Latency is the one suite that produces something besides findings: the timings themselves,
  // which the caller stores so the next run has something to diff against.
  let latency = null;
  if (suites.includes('latency')) {
    const result = await runLatency({ send, requests, baseline: latencyBaseline });
    findings.push(...result.findings);
    latency = {
      measurements: result.measurements,
      comparedAgainst: latencyBaseline?.savedAt ?? null,
    };
    ran.push('latency');
  }

  const sorted = sortFindings(findings);

  return {
    startedAt,
    finishedAt: Date.now(),
    suites: ran,
    skipped,
    latency,
    findings: sorted,
    summary: summarise(sorted),
  };
}

/**
 * Take the base identity's variables, replacing only the secret ones with the other
 * identity's. A secret is the credential; everything else describes *what* is being asked
 * for, and must not change between the two requests.
 */
function mergeCredentials(baseVars, otherVars) {
  const otherSecrets = new Map(otherVars.filter((v) => v.secret).map((v) => [v.key, v]));

  const merged = baseVars.map((v) => otherSecrets.get(v.key) ?? v);

  // A credential the other identity has and the base does not still needs to be present.
  for (const [key, variable] of otherSecrets) {
    if (!merged.some((v) => v.key === key)) merged.push(variable);
  }
  return merged;
}

/**
 * Refuse to run when the requests cannot even be addressed.
 *
 * Without this, an unselected environment leaves every URL holding {{baseUrl}}, every send
 * fails, every suite finds nothing, and the run reports "passed". A verification tool that
 * says "no problems found" when it tested nothing is worse than one that crashes: it is
 * confidently wrong, and the reader has no way to tell.
 */
function assertRequestsResolve({ requests, scope }) {
  const unresolved = new Set();
  let addressable = 0;

  for (const request of requests) {
    const raw = String(request.url ?? '');
    for (const [, name] of raw.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      const entry = scope.get(name);
      if (!entry || !entry.value) unresolved.add(name);
    }
    if (resolveUrl(raw, scope)) addressable += 1;
  }

  if (addressable === 0) {
    const detail = unresolved.size
      ? ` The following variables have no value: ${[...unresolved].join(', ')}. Select an ` +
        'environment that defines them.'
      : '';
    throw new VerifyError(
      `None of the ${requests.length} request${requests.length === 1 ? '' : 's'} in this ` +
        `project could be addressed, so nothing was tested.${detail}`,
    );
  }
}

/**
 * Refuse to run against a host the caller has not vouched for.
 *
 * The suites are intrusive by design. Pointing them at an API you do not own is at best
 * unwelcome traffic and at worst unlawful, and "I clicked the wrong environment" is an easy
 * mistake to make. Loopback is exempt because it is unambiguously the user's own machine.
 */
function assertTargetAllowed({ requests, scope, acknowledged, intrusive }) {
  if (acknowledged) return;

  const hosts = new Set();
  for (const request of requests) {
    const resolved = resolveUrl(request.url, scope);
    if (!resolved) continue;
    if (!isLoopback(resolved)) hosts.add(resolved.host);
  }

  if (hosts.size) {
    throw new VerifyError(
      `${intrusive.join(' and ')} send${intrusive.length === 1 ? 's' : ''} malformed requests ` +
        `and requests with credentials removed or swapped, so ${
          intrusive.length === 1 ? 'it needs' : 'they need'
        } confirmation before running against ${[...hosts].join(', ')}. Confirm you own or are ` +
        `authorised to test ${hosts.size > 1 ? 'these hosts' : 'this host'}, or run contract ` +
        'conformance on its own — that only sends the documented requests.',
    );
  }
}

function resolveUrl(template, scope) {
  const resolved = String(template ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => {
    const entry = scope.get(key);
    return entry ? entry.value : match;
  });

  try {
    return new URL(resolved);
  } catch {
    return null;
  }
}

function isLoopback(url) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
}
