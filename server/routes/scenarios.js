/**
 * Scenarios — ordered workflow runs saved per project.
 *
 * The run endpoint is where captures actually earn their keep: each step's captured values
 * feed the next step's variable scope, in a scope local to the run rather than the shared
 * per-project capture store the single-request runner uses. That isolation matters — a
 * scenario that captures a token must not overwrite whatever the developer captured by hand
 * while working in the editor.
 */
import express from 'express';
import { z } from 'zod';
import { runScenario } from '../verify/scenarios.js';
import { executeRequest, sanitiseRun } from '../exec/run.js';
import { applyCaptures, evaluateAssertions } from '../exec/assert.js';
import { buildScope } from '../vars.js';
import { newId } from '../model.js';
import * as store from '../store.js';
import { loadEnvironments, loadProject, loadRequests, projectDir } from './projects.js';

export const router = express.Router();

const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const scenarioInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  steps: z
    .array(
      z.object({
        requestId: z.string().min(1).max(100),
        name: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(50),
});

const runInput = z.object({
  environmentId: z.string().max(100).optional(),
});

const scenarioDir = (projectId) => `${projectDir(projectId)}/scenarios`;
const scenarioFile = (projectId, id) => `${scenarioDir(projectId)}/${id}.json`;
const runDir = (projectId) => `${projectDir(projectId)}/scenario-runs`;

/**
 * How many runs of a scenario to keep.
 *
 * Enough to see a pattern, not so many that the regression diff has to search. Only the most
 * recent is used for the comparison; the rest are there to read.
 */
const MAX_RUNS_PER_SCENARIO = 10;

async function loadScenarios(projectId) {
  const files = (await store.listDir(scenarioDir(projectId))).filter((f) => f.endsWith('.json'));

  const scenarios = [];
  for (const file of files) {
    const scenario = await store.readJson(`${scenarioDir(projectId)}/${file}`);
    if (scenario) scenarios.push(scenario);
  }
  return scenarios.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

async function loadRuns(projectId, scenarioId) {
  const files = (await store.listDir(runDir(projectId))).filter((f) => f.endsWith('.json'));

  const runs = [];
  for (const file of files) {
    const run = await store.readJson(`${runDir(projectId)}/${file}`);
    if (run && run.scenarioId === scenarioId) runs.push({ file, ...run });
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

/* ---------------------------------------------------------------- *
 * CRUD
 * ---------------------------------------------------------------- */

router.get(
  '/:projectId',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    res.json({ scenarios: await loadScenarios(req.params.projectId) });
  }),
);

router.post(
  '/:projectId',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    const input = scenarioInput.parse(req.body);

    const scenario = { id: newId(), createdAt: Date.now(), ...input };
    await store.writeJson(scenarioFile(req.params.projectId, scenario.id), scenario);
    res.status(201).json(scenario);
  }),
);

router.put(
  '/:projectId/:id',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    const existing = await store.readJson(scenarioFile(req.params.projectId, req.params.id));
    if (!existing) return res.status(404).json({ error: 'Scenario not found' });

    const input = scenarioInput.parse(req.body);
    const scenario = { ...existing, ...input };
    await store.writeJson(scenarioFile(req.params.projectId, scenario.id), scenario);
    res.json(scenario);
  }),
);

router.delete(
  '/:projectId/:id',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    await store.remove(scenarioFile(req.params.projectId, req.params.id));

    // The scenario's runs go with it: they are only readable in its context, and leaving them
    // behind would grow local_data with records nothing can reach.
    for (const run of await loadRuns(req.params.projectId, req.params.id)) {
      await store.remove(`${runDir(req.params.projectId)}/${run.file}`);
    }
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- *
 * Running
 * ---------------------------------------------------------------- */

router.post(
  '/:projectId/:id/run',
  handle(async (req, res) => {
    const project = await loadProject(req.params.projectId);
    const input = runInput.parse(req.body ?? {});

    const scenario = await store.readJson(scenarioFile(project.id, req.params.id));
    if (!scenario) return res.status(404).json({ error: 'Scenario not found' });

    let envVars = [];
    if (input.environmentId) {
      const environments = await loadEnvironments(project.id);
      const environment = environments.find((e) => e.id === input.environmentId);
      if (!environment) return res.status(404).json({ error: 'Environment not found' });
      envVars = environment.variables;
    }

    const requests = await loadRequests(project.id);

    /**
     * One step. The captures accumulated so far are folded into the scope, which is what makes
     * `{{createdId}}` in step 3 resolve to what step 1 pulled out of its response.
     */
    const execute = async (request, captures) => {
      const scope = buildScope({ projectVars: project.variables, envVars, captures });
      const raw = await executeRequest(request, { scope });

      return {
        run: sanitiseRun(raw, scope),
        assertions: evaluateAssertions(request.assertions, raw),
        // Captures read the unsanitised run, so a captured secret keeps its real value inside
        // the scenario's scope. It is masked again on the way out, in sanitiseRun above.
        values: applyCaptures(request.captures, raw).values,
      };
    };

    const [previous] = await loadRuns(project.id, scenario.id);

    const result = await runScenario({ scenario, requests, execute, previous });
    const run = { id: newId(), ...result };

    await store.writeJson(`${runDir(project.id)}/${run.id}.json`, run);

    const stored = await loadRuns(project.id, scenario.id);
    for (const old of stored.slice(MAX_RUNS_PER_SCENARIO)) {
      await store.remove(`${runDir(project.id)}/${old.file}`);
    }

    res.status(201).json(run);
  }),
);

/** Past runs of one scenario, newest first. */
router.get(
  '/:projectId/:id/runs',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    const runs = await loadRuns(req.params.projectId, req.params.id);

    // The filename is an internal detail of how runs are stored, so it does not go out.
    res.json({
      runs: runs.map((run) => {
        const copy = { ...run };
        delete copy.file;
        return copy;
      }),
    });
  }),
);
