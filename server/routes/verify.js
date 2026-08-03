/**
 * POST /api/verify — run the verification suites and store the result.
 *
 * Reports are generated from the stored run, so a report can be re-downloaded later without
 * re-running the checks against someone's API.
 */
import express from 'express';
import { z } from 'zod';
import { runVerification, SUITES } from '../verify/runner.js';
import { renderHtml } from '../verify/report/html.js';
import { renderMarkdown } from '../verify/report/markdown.js';
import { newId } from '../model.js';
import { resolveSpec } from '../verify/spec.js';
import * as store from '../store.js';
import { loadEnvironments, loadProject, loadRequests, projectDir } from './projects.js';

export const router = express.Router();

const input = z.object({
  projectId: z.string().min(1).max(100),
  requestIds: z.array(z.string().max(100)).max(500).optional(),
  suites: z.array(z.enum(SUITES)).min(1).default(SUITES),
  // Environment ids: the first is the primary identity, a second enables cross-user checks.
  environmentIds: z.array(z.string().max(100)).max(5).default([]),
  // A spec can arrive three ways: already parsed, pasted as JSON or YAML text, or as a URL.
  // "Paste the JSON" alone is a poor ask when most specs are published at a URL, in YAML.
  spec: z.unknown().optional(),
  specText: z.string().max(20_000_000).optional(),
  specUrl: z.string().max(2000).optional(),
  acknowledged: z.boolean().default(false),
});

const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/**
 * How many runs to keep per project.
 *
 * Each stored run holds the request and response evidence for every finding, so this is not
 * a handful of kilobytes — an unbounded history would grow local_data without limit, and
 * nobody reads the fortieth-oldest run.
 */
const MAX_RUNS_PER_PROJECT = 20;

async function pruneRuns(projectId) {
  const dir = `${projectDir(projectId)}/runs`;
  const files = (await store.listDir(dir)).filter((f) => f.endsWith('.json'));
  if (files.length <= MAX_RUNS_PER_PROJECT) return;

  const dated = [];
  for (const file of files) {
    const run = await store.readJson(`${dir}/${file}`);
    dated.push({ file, startedAt: run?.startedAt ?? 0 });
  }

  dated.sort((a, b) => a.startedAt - b.startedAt);
  for (const { file } of dated.slice(0, dated.length - MAX_RUNS_PER_PROJECT)) {
    await store.remove(`${dir}/${file}`);
  }
}

router.post(
  '/',
  handle(async (req, res) => {
    const body = input.parse(req.body);
    const project = await loadProject(body.projectId);

    const all = await loadRequests(project.id);
    const requests = body.requestIds?.length
      ? all.filter((r) => body.requestIds.includes(r.id))
      : all;

    const environments = await loadEnvironments(project.id);
    const identities = body.environmentIds
      .map((id) => environments.find((e) => e.id === id))
      .filter(Boolean)
      .map((env) => ({ name: env.name, variables: env.variables }));

    const spec = await resolveSpec(body);

    const result = await runVerification({
      requests,
      spec,
      suites: body.suites,
      identities,
      projectVars: project.variables,
      acknowledged: body.acknowledged,
    });

    const run = { id: newId(), target: project.name, ...result };
    await store.writeJson(`${projectDir(project.id)}/runs/${run.id}.json`, run);
    await pruneRuns(project.id);

    res.status(201).json(run);
  }),
);

/** GET a stored run's report in either format. */
router.get(
  '/:projectId/runs/:runId',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    const run = await store.readJson(
      `${projectDir(req.params.projectId)}/runs/${req.params.runId}.json`,
    );
    if (!run) return res.status(404).json({ error: 'Run not found' });

    if (req.query.format === 'html') {
      res.type('html').send(renderHtml(run));
      return;
    }
    if (req.query.format === 'markdown') {
      res.type('text/plain').send(renderMarkdown(run));
      return;
    }
    res.json(run);
  }),
);

/** List past runs, newest first, without their findings. */
router.get(
  '/:projectId/runs',
  handle(async (req, res) => {
    await loadProject(req.params.projectId);
    const files = await store.listDir(`${projectDir(req.params.projectId)}/runs`);

    const runs = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const run = await store.readJson(`${projectDir(req.params.projectId)}/runs/${file}`);
      if (run) {
        runs.push({
          id: run.id,
          target: run.target,
          startedAt: run.startedAt,
          suites: run.suites,
          summary: run.summary,
        });
      }
    }

    res.json({ runs: runs.sort((a, b) => b.startedAt - a.startedAt) });
  }),
);
