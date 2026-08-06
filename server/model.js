/**
 * Data shapes, validation, and the secret-handling rules that go with them.
 *
 * Two rules live here and are relied on by every route:
 *
 *  1. A secret variable's plaintext never leaves the server. Reads return MASK in its place.
 *  2. A write that sends MASK back means "leave it alone" — otherwise round-tripping an
 *     environment through the UI would overwrite every secret with the mask itself.
 */
import crypto from 'crypto';
import { z } from 'zod';
import { encrypt } from './crypto.js';
import { MASK } from './vars.js';

export const SCHEMA_VERSION = 2;

/* ---------------------------------------------------------------- *
 * Schemas
 * ---------------------------------------------------------------- */

const keyValue = z.object({
  key: z.string().max(1000).default(''),
  value: z.string().max(100_000).default(''),
  enabled: z.boolean().default(true),
  // When the documentation states a closed set of values, carry them so the editor can offer
  // a choice instead of asking the user to remember what the docs said.
  options: z.array(z.string().max(200)).max(100).optional(),
  description: z.string().max(1000).optional(),
});

const bodySchema = z.object({
  type: z.enum(['none', 'json', 'text', 'xml', 'form', 'multipart', 'graphql', 'binary']),
  content: z.string().max(5_000_000).optional(),
  query: z.string().max(1_000_000).optional(),
  variables: z.string().max(1_000_000).optional(),
  fields: z
    .array(
      keyValue.extend({
        type: z.enum(['text', 'file']).default('text'),
        filename: z.string().max(500).optional(),
      }),
    )
    .max(200)
    .optional(),
});

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().max(10_000).default('') }),
  z.object({
    type: z.literal('basic'),
    username: z.string().max(1000).default(''),
    password: z.string().max(1000).default(''),
  }),
  z.object({
    type: z.literal('apiKey'),
    in: z.enum(['header', 'query']).default('header'),
    key: z.string().max(500).default(''),
    value: z.string().max(10_000).default(''),
  }),
  z.object({
    type: z.literal('oauth2-cc'),
    tokenUrl: z.string().max(2000).default(''),
    clientId: z.string().max(1000).default(''),
    clientSecret: z.string().max(1000).default(''),
    scope: z.string().max(1000).optional(),
    audience: z.string().max(1000).optional(),
    clientAuth: z.enum(['header', 'body']).default('header'),
    tokenPrefix: z.string().max(50).optional(),
  }),
]);

const assertionSchema = z.object({
  type: z.enum(['status', 'header', 'jsonPath', 'responseTime', 'bodyContains']),
  target: z.string().max(500).default(''),
  operator: z
    .enum(['equals', 'notEquals', 'contains', 'lessThan', 'greaterThan', 'exists'])
    .default('equals'),
  expected: z.string().max(5000).default(''),
  enabled: z.boolean().default(true),
});

const captureSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    // The captured name becomes a {{variable}}, so it must match the placeholder grammar.
    .regex(/^[\w.-]+$/, 'Use letters, numbers, dots, dashes or underscores'),
  from: z.enum(['body', 'header', 'status']).default('body'),
  path: z.string().max(500).default(''),
  secret: z.boolean().default(false),
});

export const requestInput = z.object({
  name: z.string().min(1).max(300).default('Untitled request'),
  folderId: z.string().max(100).nullable().default(null),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  url: z.string().max(4000).default(''),
  params: z.array(keyValue).max(200).default([]),
  headers: z.array(keyValue).max(200).default([]),
  body: bodySchema.default({ type: 'none' }),
  auth: authSchema.default({ type: 'none' }),
  assertions: z.array(assertionSchema).max(100).default([]),
  captures: z.array(captureSchema).max(50).default([]),
});

/**
 * A variable carries a stable id so it can be recognised after it is renamed.
 *
 * Without it, variables were matched by key alone, and renaming a secret looked exactly like
 * creating a new empty one — so the stored value was silently discarded. The id is assigned by
 * the server; a client that omits it (a new row, or a script) still works, it just cannot
 * rename a secret in the same save.
 */
const variableSchema = keyValue.extend({
  id: z.string().max(100).optional(),
  secret: z.boolean().default(false),
});

export const projectInput = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(2000).default(''),
  variables: z.array(variableSchema).max(500).default([]),
});

export const environmentInput = z.object({
  name: z.string().min(1).max(300),
  variables: z.array(variableSchema).max(500).default([]),
});

export const transferInput = z.object({
  targetProjectId: z.string().min(1).max(100),
  mode: z.enum(['copy', 'move']).default('copy'),
  requestIds: z.array(z.string().max(100)).max(500).default([]),
  environmentIds: z.array(z.string().max(100)).max(100).default([]),
});

export const runInput = z.object({
  projectId: z.string().max(100).optional(),
  requestId: z.string().max(100).optional(),
  environmentId: z.string().max(100).nullable().optional(),
  // An unsaved request from the editor — lets you send before saving.
  request: requestInput.optional(),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
  maxRedirects: z.number().int().min(0).max(20).optional(),
});

/* ---------------------------------------------------------------- *
 * Factories
 * ---------------------------------------------------------------- */

export function newId() {
  return crypto.randomUUID();
}

export function newProject(input) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    name: input.name,
    description: input.description ?? '',
    folders: [],
    variables: encryptSecrets(input.variables ?? [], []),
    createdAt: now,
    updatedAt: now,
  };
}

export function newRequest(input) {
  const now = new Date().toISOString();
  return { schemaVersion: SCHEMA_VERSION, id: newId(), ...input, createdAt: now, updatedAt: now };
}

export function newEnvironment(input) {
  return {
    id: newId(),
    name: input.name,
    variables: encryptSecrets(input.variables ?? [], []),
  };
}

/* ---------------------------------------------------------------- *
 * Secret handling
 * ---------------------------------------------------------------- */

/** Raised when a masked secret arrives that cannot be matched to a stored one. */
export class SecretMatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretMatchError';
    this.status = 400;
  }
}

/** Give every variable a stable id, leaving any it already has alone. */
export function withVariableIds(variables = []) {
  return variables.map((v) => (v.id ? v : { ...v, id: newId() }));
}

/**
 * Encrypt any variable marked secret before it is written.
 *
 * A value equal to MASK means the client is echoing back what it was shown, so the stored value
 * is preserved. Without this, opening an environment and pressing save would replace every
 * secret with "••••".
 *
 * Matching is by **id, then key**. Key alone was the original approach and it silently
 * destroyed data: renaming a secret produced a variable whose key matched nothing stored, which
 * was indistinguishable from a brand-new empty secret, so the value was dropped without a
 * word. The id survives a rename, a reorder, and both in the same save.
 *
 * The key fallback is still needed for a client that does not send ids — a freshly typed row,
 * or a script POSTing an environment — and for data written before ids existed.
 *
 * When neither matches, this **throws rather than storing an empty value**. Refusing a save is
 * recoverable; silently discarding a credential the user cannot re-read is not.
 */
export function encryptSecrets(incoming, existing = []) {
  const byId = new Map(existing.filter((v) => v.id).map((v) => [v.id, v]));
  const byKey = new Map(existing.map((v) => [v.key, v]));

  return withVariableIds(incoming).map((variable) => {
    if (!variable.secret) return { ...variable, secret: false };

    if (variable.value !== MASK && variable.value !== '') {
      return { ...variable, value: encrypt(variable.value), secret: true };
    }

    const prior = byId.get(variable.id) ?? byKey.get(variable.key);

    // An empty value on a variable with no stored counterpart is a new, not-yet-filled secret,
    // which is a normal thing to save. Only the *mask* implies a stored value that must exist.
    if (!prior) {
      if (variable.value === MASK) {
        throw new SecretMatchError(
          `The secret "${variable.key}" was sent as its mask (${MASK}), but no stored secret ` +
            'matches it, so there is nothing to preserve. Re-enter the value and save again. ' +
            '(This usually means the variable was renamed by a client that did not send its id.)',
        );
      }
      return { ...variable, value: '', secret: true };
    }

    return { ...variable, value: prior.secret ? prior.value : '', secret: true };
  });
}

/* ---------------------------------------------------------------- *
 * Migrations
 * ---------------------------------------------------------------- */

/**
 * v1 → v2: give every variable a stable id.
 *
 * Purely additive — no value is read, rewritten or re-encrypted, so a failure part-way through
 * leaves the data exactly as usable as before. `store.migrateDocument` still takes a snapshot
 * of local_data first, since that is the guarantee the machinery makes.
 */
export const projectMigrations = {
  1: (doc) => ({
    ...doc,
    schemaVersion: 2,
    variables: withVariableIds(doc.variables ?? []),
  }),
};

export const environmentsMigrations = {
  1: (doc) => ({
    ...doc,
    schemaVersion: 2,
    environments: (doc.environments ?? []).map((env) => ({
      ...env,
      variables: withVariableIds(env.variables ?? []),
    })),
  }),
};

/** Replace every secret value with MASK. Everything returned to the client goes through this. */
export function maskSecrets(variables = []) {
  return variables.map((v) => (v.secret ? { ...v, value: v.value ? MASK : '' } : v));
}

/** Apply maskSecrets across a whole project document. */
export function publicProject(project) {
  return { ...project, variables: maskSecrets(project.variables) };
}

export function publicEnvironments(environments = []) {
  return environments.map((env) => ({ ...env, variables: maskSecrets(env.variables) }));
}

/**
 * Auth configs can hold credentials directly on a request. They are stored as written
 * (usually a {{variable}} reference), but never echoed back verbatim.
 */
const AUTH_SECRET_FIELDS = ['token', 'password', 'value', 'clientSecret'];

export function publicRequest(request) {
  if (!request?.auth) return request;

  const auth = { ...request.auth };
  for (const field of AUTH_SECRET_FIELDS) {
    // A {{placeholder}} is not itself a secret and stays visible — that is the whole point
    // of using one, and hiding it would make the editor unusable.
    if (typeof auth[field] === 'string' && auth[field] && !auth[field].includes('{{')) {
      auth[field] = MASK;
    }
  }
  return { ...request, auth };
}

/** Restore masked auth fields from what is already stored, mirroring encryptSecrets. */
export function mergeAuthSecrets(incomingAuth, existingAuth) {
  if (!incomingAuth || !existingAuth || incomingAuth.type !== existingAuth.type) {
    return incomingAuth;
  }
  const merged = { ...incomingAuth };
  for (const field of AUTH_SECRET_FIELDS) {
    if (merged[field] === MASK) merged[field] = existingAuth[field] ?? '';
  }
  return merged;
}
