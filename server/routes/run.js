/**
 * POST /api/run — execute a request.
 *
 * The request may be saved (projectId + requestId) or unsaved (a request body straight from
 * the editor), so you can send before saving. Either way execution happens here, variables
 * resolve here, and the response is sanitised before it goes back.
 */
import express from 'express';
import { executeRequest, sanitiseRun, HttpRequestError } from '../exec/run.js';
import { applyCaptures, evaluateAssertions } from '../exec/assert.js';
import { buildScope } from '../vars.js';
import { runInput } from '../model.js';
import * as store from '../store.js';
import { loadEnvironments, loadProject, projectDir, requestFile } from './projects.js';

export const router = express.Router();

/** Captured values persist for the session so a chained request can use them. */
const captureStore = new Map();

const capturesFor = (projectId) => captureStore.get(projectId) ?? {};

router.post('/', async (req, res, next) => {
  try {
    const input = runInput.parse(req.body);

    /* ---- resolve which request to run ------------------------- */

    let definition = input.request;
    let project = null;

    if (input.projectId) {
      project = await loadProject(input.projectId);

      if (input.requestId && !definition) {
        definition = await store.readJson(requestFile(input.projectId, input.requestId));
        if (!definition) return res.status(404).json({ error: 'Request not found' });
      }
    }

    if (!definition) {
      return res.status(400).json({ error: 'Provide a request to run, or a saved requestId.' });
    }

    /* ---- build the variable scope ----------------------------- */

    let envVars = [];
    if (project && input.environmentId) {
      const environments = await loadEnvironments(input.projectId);
      const environment = environments.find((e) => e.id === input.environmentId);
      if (!environment) return res.status(404).json({ error: 'Environment not found' });
      envVars = environment.variables;
    }

    const scope = buildScope({
      projectVars: project?.variables ?? [],
      envVars,
      captures: project ? capturesFor(project.id) : {},
    });

    /* ---- execute ---------------------------------------------- */

    const raw = await executeRequest(definition, {
      scope,
      timeoutMs: input.timeoutMs,
      maxRedirects: input.maxRedirects,
    });

    const assertions = evaluateAssertions(definition.assertions, raw);
    const { values, results: captures } = applyCaptures(definition.captures, raw);

    if (project && Object.keys(values).length) {
      captureStore.set(project.id, { ...capturesFor(project.id), ...values });
    }

    // The single point where a run becomes safe to show. Nothing below may reintroduce
    // an unmasked value.
    const safe = sanitiseRun(raw, scope);
    const result = {
      ...safe,
      assertions,
      captures,
      passed: assertions.every((a) => a.passed),
    };

    if (project) {
      await store.appendLine(`${projectDir(project.id)}/history.jsonl`, {
        at: new Date().toISOString(),
        requestId: input.requestId ?? null,
        name: definition.name ?? null,
        method: result.request.method,
        url: result.request.url,
        status: result.response.status,
        totalMs: result.timing.totalMs,
        passed: result.passed,
      });
    }

    res.json(result);
  } catch (err) {
    // A failed send is a normal outcome to report, not a server fault: the whole point of
    // the tool is to show what happened, including "the host refused the connection".
    if (err instanceof HttpRequestError) {
      return res.status(200).json({ error: err.message, failed: true });
    }
    next(err);
  }
});

/** Drop captured values — the UI offers this so a stale token cannot linger. */
router.delete('/captures/:projectId', (req, res) => {
  captureStore.delete(req.params.projectId);
  res.status(204).end();
});

export { captureStore };
