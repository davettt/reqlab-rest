/**
 * POST /api/codegen — turn a request into a snippet.
 */
import express from 'express';
import { z } from 'zod';
import { generate, TARGETS } from '../codegen/index.js';
import { buildScope } from '../vars.js';
import { requestInput } from '../model.js';
import { loadEnvironments, loadProject } from './projects.js';

export const router = express.Router();

const input = z.object({
  target: z.enum(TARGETS),
  request: requestInput,
  projectId: z.string().max(100).optional(),
  environmentId: z.string().max(100).nullable().optional(),
  // Off by default: a snippet gets pasted into terminals, files and chat messages.
  inlineSecrets: z.boolean().default(false),
});

router.post('/', async (req, res, next) => {
  try {
    const body = input.parse(req.body);

    let projectVars = [];
    let envVars = [];
    if (body.projectId) {
      const project = await loadProject(body.projectId);
      projectVars = project.variables;
      if (body.environmentId) {
        const environments = await loadEnvironments(body.projectId);
        envVars = environments.find((e) => e.id === body.environmentId)?.variables ?? [];
      }
    }

    const scope = buildScope({ projectVars, envVars });
    // generate() is this project's own pure string builder in server/codegen — no process is
    // spawned and no shell is involved. Semgrep matches the call shape, not the callee.
    // nosemgrep: express-wkhtmltoimage-injection
    res.json(generate(body.request, scope, body.target, { inlineSecrets: body.inlineSecrets }));
  } catch (err) {
    next(err);
  }
});
