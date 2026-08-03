/**
 * Import: preview, then apply.
 *
 * Two steps on purpose. An import can add dozens of requests and rewrite an environment, so
 * nothing is written until the user has seen exactly what would be created and said yes.
 */
import express from 'express';
import { z } from 'zod';
import { fetchDocument, looksUnstructured, parseDocument } from '../import/index.js';
import { htmlToText, importWithAi } from '../import/ai.js';
import { resolveSpecFromUrl } from '../verify/spec.js';
import { aiConfig } from './settings.js';
import { environmentInput, newEnvironment, newRequest, requestInput } from '../model.js';
import * as store from '../store.js';
import { loadEnvironments, loadProject, projectDir, requestFile } from './projects.js';

export const router = express.Router();

const previewInput = z
  .object({
    text: z.string().max(20_000_000).optional(),
    url: z.string().max(2000).optional(),
    // Opt-in: an AI pass costs money and can be wrong, so it is never the silent fallback.
    useAi: z.boolean().default(false),
    provider: z.enum(['anthropic', 'openai']).optional(),
    tier: z.enum(['fast', 'smart']).optional(),
  })
  .refine((v) => v.text || v.url, { message: 'Provide either text or a url' });

const applyInput = z.object({
  projectId: z.string().min(1).max(100),
  // Merge into an existing environment, or create one when none is chosen. Defaulting to
  // "create" produced a new environment on every import, which is not what an environment
  // is for: environments are deployment targets (dev/staging/prod) holding the same
  // variables with different values, not a record of each import.
  environmentId: z.string().max(100).nullable().optional(),
  environmentName: z.string().max(300).default('Imported'),
  requests: z.array(requestInput).max(1000),
  variables: environmentInput.shape.variables,
});

const handle = (fn) => (req, res, next) => fn(req, res, next).catch(next);

/** Look for a specification near a documentation URL. Absence is normal, not an error. */
async function discoverSpec(url) {
  try {
    const spec = await resolveSpecFromUrl(url);
    return spec ? { spec, url } : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/import/preview — parse and report, writing nothing.
 */
router.post(
  '/preview',
  handle(async (req, res) => {
    const input = previewInput.parse(req.body);
    const fetched = input.url ? await fetchDocument(input.url) : null;
    const text = fetched ? fetched.text : input.text;

    // A documentation URL often has a machine-readable specification sitting beside it. Look
    // for it before considering the AI path: a parsed spec is exact and costs nothing, where
    // inference costs a provider call and can be wrong.
    if (input.url && looksUnstructured(text)) {
      const discovered = await discoverSpec(input.url);
      if (discovered) {
        const parsed = parseDocument(JSON.stringify(discovered.spec));
        return res.json({
          redirects: fetched?.redirects ?? [],
          source: parsed.source,
          info: parsed.info,
          discoveredSpecUrl: discovered.url,
          warnings: [
            `That page is documentation, but a specification was found at ${discovered.url} ` +
              'and used instead — the result is exact rather than inferred, and no AI call was made.',
            ...parsed.warnings,
          ],
          variables: parsed.variables,
          requests: parsed.requests,
          summary: {
            requests: parsed.requests.length,
            variables: parsed.variables.length,
            secrets: parsed.variables.filter((v) => v.secret).length,
          },
        });
      }
    }

    if (looksUnstructured(text)) {
      if (!input.useAi) {
        return res.status(422).json({
          error:
            'That looks like written documentation rather than a spec. AI import can read it, ' +
            'but it costs a call to your provider and can be wrong — turn on "Use AI" to try.',
          unstructured: true,
        });
      }

      const config = await aiConfig({ provider: input.provider, tier: input.tier });
      if (!config.apiKey) {
        return res.status(422).json({
          error: `No ${config.provider} API key is configured. Add one in Settings.`,
          needsKey: true,
        });
      }

      // HTML is stripped here rather than in the parser: a fetched docs page is mostly
      // navigation, and sending it raw would waste most of the context window on markup.
      const prose = /<\/?[a-z][\s\S]*>/i.test(text) ? htmlToText(text) : text;
      const aiResult = await importWithAi(prose, config, { sourceUrl: input.url ?? null });

      return res.json({
        redirects: fetched?.redirects ?? [],
        source: aiResult.source,
        info: aiResult.info,
        warnings: aiResult.warnings,
        variables: aiResult.variables,
        requests: aiResult.requests,
        summary: {
          requests: aiResult.requests.length,
          variables: aiResult.variables.length,
          secrets: aiResult.variables.filter((v) => v.secret).length,
        },
      });
    }

    const parsed = parseDocument(text);

    res.json({
      // Surfaced so a spec URL that quietly redirects elsewhere is visible, not silent.
      redirects: fetched?.redirects ?? [],
      source: parsed.source,
      info: parsed.info,
      warnings: parsed.warnings,
      variables: parsed.variables,
      requests: parsed.requests,
      summary: {
        requests: parsed.requests.length,
        variables: parsed.variables.length,
        secrets: parsed.variables.filter((v) => v.secret).length,
      },
    });
  }),
);

/**
 * POST /api/import/apply — create the reviewed requests and an environment for them.
 */
router.post(
  '/apply',
  handle(async (req, res) => {
    const input = applyInput.parse(req.body);
    const project = await loadProject(input.projectId);

    const created = [];
    for (const definition of input.requests) {
      const request = newRequest(definition);
      await store.writeJson(requestFile(project.id, request.id), request);
      created.push(request.name);
    }

    let environmentId = input.environmentId ?? null;
    const added = [];
    const kept = [];

    if (input.variables.length) {
      const environments = await loadEnvironments(project.id);
      const target = environmentId ? environments.find((e) => e.id === environmentId) : null;

      if (environmentId && !target) {
        return res.status(404).json({ error: 'Environment not found' });
      }

      if (target) {
        // Existing values win. A variable already set — especially a secret already filled
        // in — must not be reset to empty by a later import of the same API.
        for (const variable of input.variables) {
          const existing = target.variables.find((v) => v.key === variable.key);
          if (existing) {
            kept.push(variable.key);
            continue;
          }
          target.variables.push(variable);
          added.push(variable.key);
        }
      } else {
        const environment = newEnvironment({
          name: input.environmentName,
          variables: input.variables,
        });
        environments.push(environment);
        environmentId = environment.id;
        added.push(...input.variables.map((v) => v.key));
      }

      await store.writeJson(`${projectDir(project.id)}/environments.json`, { environments });
    }

    res.status(201).json({
      requests: created.length,
      environmentId,
      addedVariables: added,
      keptVariables: kept,
      // Only the ones actually added still need filling in — a secret already set is fine.
      secretsToFill: input.variables
        .filter((v) => v.secret && added.includes(v.key))
        .map((v) => v.key),
    });
  }),
);
