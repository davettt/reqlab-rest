/**
 * Projects, their requests, and their environments.
 *
 * Every response passes through the public* helpers in model.js, so a secret's plaintext
 * cannot reach the browser even by accident.
 */
import express from 'express';
import {
  SCHEMA_VERSION,
  environmentInput,
  environmentsMigrations,
  newId,
  projectMigrations,
  transferInput,
  encryptSecrets,
  mergeAuthSecrets,
  newEnvironment,
  newProject,
  newRequest,
  projectInput,
  publicEnvironments,
  publicProject,
  publicRequest,
  requestInput,
} from '../model.js';
import * as store from '../store.js';

export const router = express.Router();

/* ---------------------------------------------------------------- *
 * Paths and loaders
 * ---------------------------------------------------------------- */

/**
 * Ids come from the URL, so they are constrained to a UUID-ish shape before being used in a
 * path. store.resolveDataPath() rejects traversal too, but a bad id should 400, not 500.
 */
const ID = /^[\w-]{1,64}$/;

function assertId(id, what) {
  if (!ID.test(id ?? '')) {
    const err = new Error(`Invalid ${what} id`);
    err.status = 400;
    throw err;
  }
  return id;
}

const projectDir = (id) => `projects/${assertId(id, 'project')}`;
const projectFile = (id) => `${projectDir(id)}/project.json`;
const requestFile = (pid, rid) => `${projectDir(pid)}/requests/${assertId(rid, 'request')}.json`;
const environmentsFile = (id) => `${projectDir(id)}/environments.json`;

/**
 * Read a document, migrate it if it predates this build, and persist the result.
 *
 * Persisting matters: a migration applied on every read but never written back would hand out
 * ids that vanish before the following save, which is precisely the mismatch the ids exist to
 * prevent. `store.migrateDocument` snapshots local_data before the first migration in a
 * process, and returns the document untouched when it is already current.
 */
async function loadMigrated(path, { fallback = null, migrations, label }) {
  const doc = await store.readJson(path, fallback);
  if (!doc) return doc;

  const migrated = await store.migrateDocument(doc, {
    targetVersion: SCHEMA_VERSION,
    migrations,
    label,
  });

  if (migrated !== doc) await store.writeJson(path, migrated);
  return migrated;
}

async function loadProject(id) {
  const project = await loadMigrated(projectFile(id), {
    migrations: projectMigrations,
    label: `Project ${id}`,
  });

  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  return project;
}

async function loadRequests(projectId) {
  const files = await store.listDir(`${projectDir(projectId)}/requests`);
  const requests = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const request = await store.readJson(`${projectDir(projectId)}/requests/${file}`);
    if (request) requests.push(request);
  }
  return requests.sort((a, b) => a.name.localeCompare(b.name));
}

async function loadEnvironments(projectId) {
  const doc = await loadMigrated(environmentsFile(projectId), {
    fallback: { schemaVersion: SCHEMA_VERSION, environments: [] },
    migrations: environmentsMigrations,
    label: `Environments for project ${projectId}`,
  });
  return doc.environments;
}

/** Every write must stamp the version, or the next read would migrate the document again. */
async function saveEnvironments(projectId, environments) {
  await store.writeJson(environmentsFile(projectId), {
    schemaVersion: SCHEMA_VERSION,
    environments,
  });
}

/** Wraps an async handler so a rejection reaches Express's error handler. */
const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/* ---------------------------------------------------------------- *
 * Projects
 * ---------------------------------------------------------------- */

router.get(
  '/',
  handle(async (_req, res) => {
    const ids = await store.listDir('projects');
    const projects = [];
    for (const id of ids) {
      const project = await store.readJson(`projects/${id}/project.json`);
      if (project) {
        projects.push({
          id: project.id,
          name: project.name,
          description: project.description,
          updatedAt: project.updatedAt,
        });
      }
    }
    res.json({ projects: projects.sort((a, b) => a.name.localeCompare(b.name)) });
  }),
);

router.post(
  '/',
  handle(async (req, res) => {
    const project = newProject(projectInput.parse(req.body));
    await store.writeJson(projectFile(project.id), project);
    res.status(201).location(`/api/projects/${project.id}`).json(publicProject(project));
  }),
);

router.get(
  '/:id',
  handle(async (req, res) => {
    const project = await loadProject(req.params.id);
    res.json({
      project: publicProject(project),
      requests: (await loadRequests(req.params.id)).map(publicRequest),
      environments: publicEnvironments(await loadEnvironments(req.params.id)),
    });
  }),
);

router.patch(
  '/:id',
  handle(async (req, res) => {
    const existing = await loadProject(req.params.id);
    const input = projectInput.partial().parse(req.body);

    const updated = {
      ...existing,
      ...input,
      variables: input.variables
        ? encryptSecrets(input.variables, existing.variables)
        : existing.variables,
      updatedAt: new Date().toISOString(),
    };
    await store.save(projectFile(req.params.id), updated);
    res.json(publicProject(updated));
  }),
);

router.delete(
  '/:id',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    // Cascade: the project directory holds its requests, environments and history.
    await store.remove(projectDir(req.params.id));
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- *
 * Requests
 * ---------------------------------------------------------------- */

router.post(
  '/:id/requests',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    const request = newRequest(requestInput.parse(req.body));
    await store.writeJson(requestFile(req.params.id, request.id), request);
    res.status(201).json(publicRequest(request));
  }),
);

router.get(
  '/:id/requests/:requestId',
  handle(async (req, res) => {
    const request = await store.readJson(requestFile(req.params.id, req.params.requestId));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(publicRequest(request));
  }),
);

router.patch(
  '/:id/requests/:requestId',
  handle(async (req, res) => {
    const path = requestFile(req.params.id, req.params.requestId);
    const existing = await store.readJson(path);
    if (!existing) return res.status(404).json({ error: 'Request not found' });

    const input = requestInput.partial().parse(req.body);
    const updated = {
      ...existing,
      ...input,
      auth: input.auth ? mergeAuthSecrets(input.auth, existing.auth) : existing.auth,
      updatedAt: new Date().toISOString(),
    };
    await store.save(path, updated);
    res.json(publicRequest(updated));
  }),
);

router.delete(
  '/:id/requests/:requestId',
  handle(async (req, res) => {
    const path = requestFile(req.params.id, req.params.requestId);
    if (!(await store.exists(path))) return res.status(404).json({ error: 'Request not found' });
    await store.remove(path);
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- *
 * Environments
 * ---------------------------------------------------------------- */

router.get(
  '/:id/environments',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    res.json({ environments: publicEnvironments(await loadEnvironments(req.params.id)) });
  }),
);

router.post(
  '/:id/environments',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    const environments = await loadEnvironments(req.params.id);
    const environment = newEnvironment(environmentInput.parse(req.body));
    environments.push(environment);
    await saveEnvironments(req.params.id, environments);
    res.status(201).json(publicEnvironments([environment])[0]);
  }),
);

router.patch(
  '/:id/environments/:environmentId',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    const environments = await loadEnvironments(req.params.id);
    const index = environments.findIndex((e) => e.id === req.params.environmentId);
    if (index === -1) return res.status(404).json({ error: 'Environment not found' });

    const input = environmentInput.partial().parse(req.body);
    const existing = environments[index];
    environments[index] = {
      ...existing,
      ...input,
      variables: input.variables
        ? encryptSecrets(input.variables, existing.variables)
        : existing.variables,
    };
    await saveEnvironments(req.params.id, environments);
    res.json(publicEnvironments([environments[index]])[0]);
  }),
);

router.delete(
  '/:id/environments/:environmentId',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    const environments = await loadEnvironments(req.params.id);
    const remaining = environments.filter((e) => e.id !== req.params.environmentId);
    if (remaining.length === environments.length) {
      return res.status(404).json({ error: 'Environment not found' });
    }
    await saveEnvironments(req.params.id, remaining);
    res.status(204).end();
  }),
);

/* ---------------------------------------------------------------- *
 * Transfer between projects
 * ---------------------------------------------------------------- */

/**
 * Copy or move requests and environments into another project.
 *
 * Secret values are carried across as stored — already encrypted under this machine's key —
 * so a credential is never decrypted, re-encrypted, or held in memory in plaintext just to
 * be filed somewhere else.
 */
router.post(
  '/:id/transfer',
  handle(async (req, res) => {
    const source = await loadProject(req.params.id);
    const input = transferInput.parse(req.body);
    const target = await loadProject(input.targetProjectId);

    if (source.id === target.id) {
      return res.status(400).json({ error: 'Source and target project are the same.' });
    }

    const moved = { requests: [], environments: [] };

    /* ---- requests ---- */
    for (const requestId of input.requestIds ?? []) {
      const request = await store.readJson(requestFile(source.id, requestId));
      if (!request) continue;

      // A new id, so a copy never collides with the original.
      const copy = { ...request, id: newId(), createdAt: new Date().toISOString() };
      await store.writeJson(requestFile(target.id, copy.id), copy);
      moved.requests.push(copy.name);

      if (input.mode === 'move') await store.remove(requestFile(source.id, requestId));
    }

    /* ---- environments ---- */
    if ((input.environmentIds ?? []).length) {
      const sourceEnvs = await loadEnvironments(source.id);
      const targetEnvs = await loadEnvironments(target.id);
      const keep = [];

      for (const env of sourceEnvs) {
        if (!input.environmentIds.includes(env.id)) {
          keep.push(env);
          continue;
        }
        targetEnvs.push({ ...env, id: newId() });
        moved.environments.push(env.name);
        if (input.mode === 'copy') keep.push(env);
      }

      await saveEnvironments(target.id, targetEnvs);
      if (input.mode === 'move') {
        await saveEnvironments(source.id, keep);
      }
    }

    res.json({ mode: input.mode, target: target.name, ...moved });
  }),
);

/* ---------------------------------------------------------------- *
 * History
 * ---------------------------------------------------------------- */

router.get(
  '/:id/history',
  handle(async (req, res) => {
    await loadProject(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({
      history: await store.readLines(`${projectDir(req.params.id)}/history.jsonl`, { limit }),
    });
  }),
);

export { loadProject, loadRequests, loadEnvironments, projectDir, requestFile };
