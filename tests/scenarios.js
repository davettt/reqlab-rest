/**
 * Scenario and regression-diff tests. Run: npm run test:scenarios
 *
 * The two things worth proving here are the ones a scenario runner gets wrong most easily:
 * a value captured in one step actually reaching the next, and a failed step stopping the run
 * rather than letting the rest fail confusingly behind it. Everything after that is diffing.
 */
import { test, assert, assertEqual, summarise } from './util.js';
import { startFixture } from './fixtures/server.js';
import { runScenario } from '../server/verify/scenarios.js';
import { diffBodies, describeDifferences } from '../server/verify/diff.js';
import { executeRequest, sanitiseRun } from '../server/exec/run.js';
import { applyCaptures, evaluateAssertions } from '../server/exec/assert.js';
import { buildScope } from '../server/vars.js';

console.log('scenarios: reqlab-rest');

const fixture = await startFixture();

const envVars = [{ key: 'baseUrl', value: fixture.base, enabled: true }];

/** The same wiring the route uses: captures accumulate into the next step's scope. */
const execute = async (request, captures) => {
  const scope = buildScope({ envVars, captures });
  const raw = await executeRequest(request, { scope });

  return {
    run: sanitiseRun(raw, scope),
    assertions: evaluateAssertions(request.assertions, raw),
    values: applyCaptures(request.captures, raw).values,
  };
};

const request = (id, method, url, extra = {}) => ({
  id,
  name: `${method} ${url}`,
  method,
  url: `{{baseUrl}}${url}`,
  params: [],
  headers: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  assertions: [],
  captures: [],
  ...extra,
});

try {
  /* ---- captures feed the next step ----------------------------- */

  await test('a value captured in one step is used by the next', async () => {
    const create = request('r1', 'POST', '/good/widgets', {
      body: { type: 'json', content: '{"name":"chained"}' },
      captures: [{ name: 'widgetId', from: 'body', path: 'id' }],
      assertions: [{ type: 'status', operator: 'equals', expected: '201' }],
    });

    // /echo reflects the query back, so the captured id landing in the URL is directly
    // observable rather than inferred.
    const use = request('r2', 'GET', '/echo', {
      params: [{ key: 'widget', value: '{{widgetId}}', enabled: true }],
      assertions: [{ type: 'bodyContains', operator: 'contains', expected: 'chained' }],
    });

    const result = await runScenario({
      scenario: {
        id: 's1',
        name: 'Create then read',
        steps: [{ requestId: 'r1' }, { requestId: 'r2' }],
      },
      requests: [create, use],
      execute,
    });

    assertEqual(result.steps.length, 2, 'both steps ran');
    assertEqual(result.steps[0].outcome, 'passed', 'the create passed');
    assert(result.steps[0].captured.includes('widgetId'), 'the id was captured');

    const echoed = JSON.parse(result.steps[1].body);
    assert(echoed.query.widget, 'the captured value reached the second request');
    assert(!echoed.query.widget.includes('{{'), `unresolved: ${echoed.query.widget}`);
  });

  /* ---- a failed step stops the run ----------------------------- */

  await test('a failed step stops the run and the rest report as not run', async () => {
    const failing = request('r1', 'GET', '/status/500', {
      assertions: [{ type: 'status', operator: 'equals', expected: '200' }],
    });
    const later = request('r2', 'GET', '/echo');

    const result = await runScenario({
      scenario: { id: 's2', name: 'Halts', steps: [{ requestId: 'r1' }, { requestId: 'r2' }] },
      requests: [failing, later],
      execute,
    });

    assertEqual(result.steps[0].outcome, 'failed', 'the first step failed');
    // Not "passed" and not absent: a step that never ran must be visibly untested, or the
    // summary implies coverage the run does not have.
    assertEqual(result.steps[1].outcome, 'not-run', 'the second step is marked not run');
    assertEqual(result.passed, false, 'the scenario did not pass');

    const halted = result.findings.find((f) => f.title.includes('did not run'));
    assert(halted, 'the halt is reported');
    assert(halted.whyItMatters.includes('not passing'), 'and says untested is not passing');
  });

  await test('a step pointing at a deleted request is explained, not crashed on', async () => {
    const result = await runScenario({
      scenario: { id: 's3', name: 'Stale', steps: [{ requestId: 'gone' }] },
      requests: [],
      execute,
    });

    const missing = result.findings.find((f) => f.title.includes('no longer exists'));
    assert(missing, 'the missing request is reported');
    assertEqual(missing.severity, 'major', 'it stops the scenario, so it is major');
  });

  /* ---- regression diffing -------------------------------------- */

  await test('a changed status between runs is reported', async () => {
    const previous = {
      scenarioId: 's4',
      steps: [{ position: 1, name: 'read', status: 200, outcome: 'passed', body: '{"ok":true}' }],
    };

    const result = await runScenario({
      scenario: { id: 's4', name: 'Regression', steps: [{ requestId: 'r1' }] },
      requests: [request('r1', 'GET', '/status/404')],
      execute,
      previous,
    });

    const change = result.findings.find((f) => f.title.includes('now returns 404'));
    assert(change, `expected a status regression, got: ${result.findings.map((f) => f.title)}`);
    assertEqual(change.severity, 'major', 'working then failing is major');
  });

  await test('a changed body is reported as information, not a failure', async () => {
    const previous = {
      scenarioId: 's5',
      steps: [
        {
          position: 1,
          name: 'echo',
          status: 200,
          outcome: 'passed',
          body: JSON.stringify({ method: 'GET', path: '/echo', query: { a: 'old' } }),
        },
      ],
    };

    const result = await runScenario({
      scenario: { id: 's5', name: 'Body drift', steps: [{ requestId: 'r1' }] },
      requests: [
        request('r1', 'GET', '/echo', {
          params: [{ key: 'a', value: 'new', enabled: true }],
        }),
      ],
      execute,
      previous,
    });

    const drift = result.findings.find((f) => f.title.includes('different data than last run'));
    assert(drift, `expected a body diff, got: ${result.findings.map((f) => f.title)}`);
    // Nothing failed — every assertion passed. It is reported because a field that silently
    // changes breaks clients without breaking a test.
    assertEqual(drift.severity, 'info', 'a body change with a passing run is information');
    assert(drift.whatHappened.includes('old'), 'names what the value was');
  });

  await test('an identical run produces no regression findings', async () => {
    const steps = [{ requestId: 'r1' }];
    const requests = [request('r1', 'GET', '/good/document')];
    const scenario = { id: 's6', name: 'Stable', steps };

    const first = await runScenario({ scenario, requests, execute });
    const second = await runScenario({ scenario, requests, execute, previous: first });

    const regressions = second.findings.filter((f) => f.suite === 'scenario');
    assertEqual(regressions.length, 0, `false positives: ${regressions.map((f) => f.title)}`);
  });

  /* ---- the diff itself ----------------------------------------- */

  await test('volatile fields are excluded from a diff', () => {
    const before = JSON.stringify({ id: 1, name: 'a', updatedAt: '2026-01-01T00:00:00Z' });
    const after = JSON.stringify({ id: 1, name: 'a', updatedAt: '2026-08-04T09:00:00Z' });

    assertEqual(diffBodies(before, after).length, 0, 'a moving timestamp is not a difference');
  });

  await test('a real change is still caught alongside volatile ones', () => {
    const before = JSON.stringify({ name: 'a', requestId: 'x', total: 10 });
    const after = JSON.stringify({ name: 'b', requestId: 'y', total: 10 });

    const differences = diffBodies(before, after);
    assertEqual(differences.length, 1, 'only the real change is reported');
    assert(differences[0].includes('name'), 'and it names the field');
    assert(describeDifferences(differences).endsWith('.'), 'the description reads as a sentence');
  });

  await test('a field that disappears is reported', () => {
    const differences = diffBodies(JSON.stringify({ a: 1, b: 2 }), JSON.stringify({ a: 1 }));
    assertEqual(differences.length, 1, 'one difference');
    assert(differences[0].includes('absent'), `should say it went absent: ${differences[0]}`);
  });

  await test('a list that changes length is reported without enumerating every entry', () => {
    const before = JSON.stringify({ data: [1, 2, 3] });
    const after = JSON.stringify({ data: [1, 2] });

    const differences = diffBodies(before, after);
    assertEqual(differences.length, 1, 'the length change is one finding, not three');
    assert(differences[0].includes('3 entries'), 'names both lengths');
  });

  await test('non-JSON bodies fall back to an exact comparison', () => {
    assertEqual(diffBodies('hello', 'hello').length, 0, 'identical text does not differ');
    assertEqual(diffBodies('hello', 'goodbye').length, 1, 'different text does');
  });
} finally {
  await fixture.stop();
}

summarise('scenarios');
