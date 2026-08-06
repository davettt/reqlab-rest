/**
 * Workflow scenarios: an ordered run where each step can use what the last one returned.
 *
 * A single request tells you an endpoint works. It does not tell you the API works, because
 * the interesting failures live between endpoints — create returns an id the read endpoint
 * cannot find, update succeeds but list still shows the old value, delete returns 204 and the
 * record is still there. The usual shape is create → read → update → list → delete → verify
 * gone, and every one of those steps needs a value the previous step produced.
 *
 * Two behaviours worth stating plainly, because both are the difference between a useful
 * result and a misleading one:
 *
 *  - **A failed step stops the run.** Steps after it are recorded as not run, never as passed.
 *    Continuing would send the remaining requests with a stale or missing captured value and
 *    produce a cascade of failures that all point at the wrong step.
 *  - **The run is compared against the previous one.** A scenario that passes today and passed
 *    last week can still have changed what it returns, and a field that quietly disappeared
 *    from a response breaks callers without failing a single assertion.
 */
import { finding, evidenceFrom } from './findings.js';
import { diffBodies, describeDifferences } from './diff.js';

const SUITE = 'scenario';

/** Keeps a stored run to a sensible size while leaving enough body to diff meaningfully. */
const MAX_STORED_BODY = 4000;

/**
 * @param {object} args
 * @param {object} args.scenario           { id, name, steps: [{ requestId }] }
 * @param {object[]} args.requests         the project's saved requests
 * @param {Function} args.execute          async (request, captures) => { run, assertions, values }
 * @param {object} [args.previous]         the previous stored run of this scenario
 */
export async function runScenario({ scenario, requests, execute, previous = null }) {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const startedAt = Date.now();

  const steps = [];
  const findings = [];
  const captures = {};
  let stopped = false;

  for (const [index, step] of (scenario.steps ?? []).entries()) {
    const request = byId.get(step.requestId);
    const position = index + 1;

    if (!request) {
      steps.push({
        position,
        name: step.name ?? 'Missing request',
        requestId: step.requestId,
        outcome: 'missing',
      });
      findings.push(missingRequestFinding({ scenario, position, step }));
      stopped = true;
      break;
    }

    if (stopped) {
      steps.push({ position, name: request.name, requestId: request.id, outcome: 'not-run' });
      continue;
    }

    let result;
    try {
      result = await execute(request, captures);
    } catch (err) {
      steps.push({
        position,
        name: request.name,
        requestId: request.id,
        method: request.method,
        outcome: 'error',
        error: err.message,
      });
      findings.push(transportFailureFinding({ scenario, position, request, message: err.message }));
      stopped = true;
      continue;
    }

    Object.assign(captures, result.values ?? {});

    const failed = (result.assertions ?? []).filter((a) => !a.passed);
    const record = {
      position,
      name: request.name,
      requestId: request.id,
      method: request.method,
      url: result.run.request?.url ?? request.url,
      status: result.run.response?.status ?? null,
      timingMs: result.run.timing?.totalMs ?? null,
      body: String(result.run.response?.body ?? '').slice(0, MAX_STORED_BODY),
      assertions: result.assertions ?? [],
      captured: Object.keys(result.values ?? {}),
      outcome: failed.length ? 'failed' : 'passed',
    };
    steps.push(record);

    if (failed.length) {
      findings.push(assertionFinding({ scenario, position, request, failed, run: result.run }));
      stopped = true;
    }
  }

  const notRun = steps.filter((s) => s.outcome === 'not-run');
  if (notRun.length) {
    findings.push(haltedFinding({ scenario, steps, notRun }));
  }

  const current = {
    scenarioId: scenario.id,
    name: scenario.name,
    startedAt,
    finishedAt: Date.now(),
    steps,
    passed: steps.every((s) => s.outcome === 'passed'),
  };

  if (previous) findings.push(...diffAgainst({ scenario, previous, current }));

  return { ...current, findings };
}

/* ---------------------------------------------------------------- *
 * Regression: what changed since the last run
 * ---------------------------------------------------------------- */

/**
 * Compare this run against the previous one, step by step.
 *
 * Matched by position rather than by request id, because a scenario is an ordered thing: the
 * same request used twice (read before update, read after) is two different steps, and matching
 * on id would compare the wrong pair.
 */
function diffAgainst({ scenario, previous, current }) {
  const findings = [];
  const before = new Map((previous.steps ?? []).map((s) => [s.position, s]));

  for (const step of current.steps) {
    const old = before.get(step.position);
    if (!old || old.outcome === 'not-run' || step.outcome === 'not-run') continue;

    if (old.status !== step.status && old.status !== undefined && step.status !== null) {
      findings.push(
        finding({
          suite: SUITE,
          severity: statusSeverity(old.status, step.status),
          endpoint: `${scenario.name} — step ${step.position}: ${step.name}`,
          title: `Step ${step.position} of "${scenario.name}" now returns ${step.status}`,
          whatHappened: `It returned ${old.status} on the previous run and ${step.status} now.`,
          whyItMatters:
            'The workflow behaves differently than it did last time it was checked. Whether ' +
            'that is a fix or a regression, it is a change to what callers of this sequence ' +
            'receive, and it happened between the two runs.',
          expected: `${old.status}, as before`,
          actual: String(step.status),
        }),
      );
      continue; // a changed status makes a body diff noise
    }

    const differences = diffBodies(old.body, step.body);
    const description = describeDifferences(differences);
    if (!description) continue;

    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: `${scenario.name} — step ${step.position}: ${step.name}`,
        title: `Step ${step.position} of "${scenario.name}" returns different data than last run`,
        whatHappened: description,
        whyItMatters:
          'The status is unchanged and every assertion still passes, so nothing here is ' +
          'failing. It is reported because a field that quietly changes shape or disappears ' +
          'breaks the clients reading it without breaking any test. Values that move on every ' +
          'call — timestamps, ids, ETags — are excluded from this comparison.',
        expected: 'the same response as the previous run',
        actual: `${differences.length} field(s) differed`,
      }),
    );
  }

  return findings;
}

/**
 * A move into or out of the error range is a real change; 200 becoming 201 is a change of a
 * different order, and reporting both as major would flatten a distinction the reader needs.
 */
function statusSeverity(before, after) {
  const wasOk = before < 400;
  const isOk = after < 400;
  if (wasOk && !isOk) return 'major';
  if (!wasOk && isOk) return 'info';
  return 'minor';
}

/* ---------------------------------------------------------------- *
 * Findings
 * ---------------------------------------------------------------- */

function assertionFinding({ scenario, position, request, failed, run }) {
  const first = failed[0];

  return finding({
    suite: SUITE,
    severity: 'major',
    endpoint: `${scenario.name} — step ${position}: ${request.name}`,
    title: `Step ${position} of "${scenario.name}" failed: ${request.name}`,
    whatHappened:
      `${failed.length} check${failed.length === 1 ? '' : 's'} failed on this step. ` +
      `${first.summary ?? `the ${first.type} check did not hold`}.`,
    whyItMatters:
      'This step is part of an ordered workflow, so the steps after it did not run. Whatever ' +
      'the sequence represents — signing up, placing an order, deleting an account — it cannot ' +
      'be completed while this step fails.',
    expected: first.expected ?? 'the check to pass',
    actual: first.actual ?? 'it did not',
    evidence: evidenceFrom(run),
  });
}

function transportFailureFinding({ scenario, position, request, message }) {
  return finding({
    suite: SUITE,
    severity: 'major',
    endpoint: `${scenario.name} — step ${position}: ${request.name}`,
    title: `Step ${position} of "${scenario.name}" could not be sent`,
    whatHappened: message,
    whyItMatters:
      'The request never reached the API, so this says nothing about whether the endpoint is ' +
      'correct. The usual causes are an unresolved variable — often one an earlier step was ' +
      'supposed to capture — or the service not being reachable.',
    expected: 'the request to be sent',
    actual: message,
  });
}

function missingRequestFinding({ scenario, position, step }) {
  return finding({
    suite: SUITE,
    severity: 'major',
    endpoint: `${scenario.name} — step ${position}`,
    title: `Step ${position} of "${scenario.name}" refers to a request that no longer exists`,
    whatHappened: `The step points at request ${step.requestId}, which is not in this project.`,
    whyItMatters:
      'The scenario cannot run past this point. A request it depended on was probably deleted ' +
      'or moved to another project; edit the scenario to point at the current one.',
    expected: 'a request that exists',
    actual: 'a deleted or moved request',
  });
}

function haltedFinding({ scenario, steps, notRun }) {
  const failedStep = steps.find((s) => s.outcome === 'failed' || s.outcome === 'error');

  return finding({
    suite: SUITE,
    severity: 'info',
    endpoint: `${scenario.name}`,
    title: `${notRun.length} step${notRun.length === 1 ? '' : 's'} of "${scenario.name}" did not run`,
    whatHappened:
      `The run stopped at step ${failedStep?.position ?? '?'}, so ` +
      `${notRun.map((s) => `step ${s.position}`).join(', ')} ${
        notRun.length === 1 ? 'was' : 'were'
      } not attempted.`,
    whyItMatters:
      'Those steps are untested by this run, not passing. Continuing past a failed step would ' +
      'send the rest of the sequence with a missing or stale captured value and produce ' +
      'failures that all point at the wrong place.',
    expected: `all ${steps.length} steps to run`,
    actual: `${steps.length - notRun.length} ran`,
  });
}
