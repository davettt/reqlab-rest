/**
 * Unit tests for the server modules that have no HTTP surface. No dependencies beyond Node.
 * Run: npm run test:unit
 */
import nodeCrypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { test, assert, assertEqual, summarise, sleep } from './util.js';

// store.js reads its root at import time, so point it at a scratch dir before importing.
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), 'reqlab-store-'));
process.env.REQLAB_DATA_DIR = SCRATCH;

const store = await import('../server/store.js');
const crypto = await import('../server/crypto.js');
const vars = await import('../server/vars.js');

console.log('unit: reqlab-rest');

/* ---------------------------------------------------------------- *
 * crypto.js
 * ---------------------------------------------------------------- */

await test('crypto: machine-keyed round trip', () => {
  const sealed = crypto.encrypt('sk-live-abc123');
  assert(sealed.startsWith('enc:'), 'should carry the enc: prefix');
  assert(!sealed.includes('sk-live-abc123'), 'ciphertext must not contain the plaintext');
  assertEqual(crypto.decrypt(sealed), 'sk-live-abc123', 'round trip');
});

await test('crypto: encryption is non-deterministic', () => {
  assert(crypto.encrypt('same') !== crypto.encrypt('same'), 'random IV per call');
});

await test('crypto: plaintext passes through (auto-migration)', () => {
  assertEqual(crypto.decrypt('legacy-plaintext-key'), 'legacy-plaintext-key', 'passthrough');
  assertEqual(crypto.isEncrypted('legacy-plaintext-key'), false, 'not flagged as encrypted');
});

await test('crypto: a foreign machine key fails loudly, never silently', () => {
  // Same format, different key — what a synced local_data/ from another machine looks like.
  const foreignKey = nodeCrypto.createHash('sha256').update('someone-elses-machine').digest();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', foreignKey, iv);
  const ct = Buffer.concat([cipher.update('their-secret', 'utf8'), cipher.final()]);
  const foreign = 'enc:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');

  assertEqual(crypto.isForeign(foreign), true, 'should be detected as foreign');
  let threw = false;
  try {
    crypto.decrypt(foreign);
  } catch {
    threw = true;
  }
  assert(threw, 'decrypt must throw rather than return ciphertext');
});

await test('crypto: tampering is rejected (GCM auth tag)', () => {
  const sealed = crypto.encrypt('honest-value');
  const payload = Buffer.from(sealed.slice(4), 'base64');
  payload[payload.length - 1] ^= 0xff;
  const tampered = 'enc:' + payload.toString('base64');

  let threw = false;
  try {
    crypto.decrypt(tampered);
  } catch {
    threw = true;
  }
  assert(threw, 'a modified ciphertext must not decrypt');
});

await test('crypto: a truncated payload is rejected', () => {
  const sealed = crypto.encrypt('honest-value');
  const payload = Buffer.from(sealed.slice(4), 'base64');
  // Short enough that it cannot hold an IV plus a full-length auth tag.
  const truncated = 'enc:' + payload.subarray(0, 20).toString('base64');

  let threw = false;
  try {
    crypto.decrypt(truncated);
  } catch {
    threw = true;
  }
  assert(threw, 'a short-tag payload must never be accepted');
});

await test('crypto: passphrase round trip, and wrong passphrase fails', () => {
  const sealed = crypto.encryptWithPassphrase('portable-secret', 'correct horse battery');
  assert(sealed.startsWith('encp:'), 'should carry the encp: prefix');
  assertEqual(crypto.decryptWithPassphrase(sealed, 'correct horse battery'), 'portable-secret');

  let threw = false;
  try {
    crypto.decryptWithPassphrase(sealed, 'wrong passphrase');
  } catch {
    threw = true;
  }
  assert(threw, 'wrong passphrase must throw');
});

/* ---------------------------------------------------------------- *
 * store.js
 * ---------------------------------------------------------------- */

await test('store: write and read back', async () => {
  await store.writeJson('projects/p1/project.json', { name: 'Payments API' });
  const read = await store.readJson('projects/p1/project.json');
  assertEqual(read.name, 'Payments API', 'round trip');
});

await test('store: missing file returns the fallback', async () => {
  assertEqual(await store.readJson('nope.json', null), null, 'fallback');
});

await test('store: refuses paths escaping local_data', async () => {
  let threw = false;
  try {
    await store.readJson('../../../etc/passwd');
  } catch {
    threw = true;
  }
  assert(threw, 'traversal must be rejected');
});

await test('store: debounced writes coalesce into one file write', async () => {
  store.save('projects/p1/notes.json', { n: 1 });
  store.save('projects/p1/notes.json', { n: 2 });
  const last = store.save('projects/p1/notes.json', { n: 3 });
  await last;
  const read = await store.readJson('projects/p1/notes.json');
  assertEqual(read.n, 3, 'last value wins');
});

await test('store: pending writes are readable before they hit disk', async () => {
  store.save('projects/p1/pending.json', { staged: true }, { debounceMs: 5000 });
  const read = await store.readJson('projects/p1/pending.json');
  assertEqual(read.staged, true, 'read-your-writes');
  await store.flush('projects/p1/pending.json');
});

await test('store: no temp files are left behind', async () => {
  await store.flush();
  const entries = await fs.readdir(path.join(SCRATCH, 'projects/p1'));
  assertEqual(
    entries.filter((e) => e.includes('.tmp')).length,
    0,
    'temp files should be renamed away',
  );
});

await test('store: append log trims to the cap, newest first on read', async () => {
  for (let i = 0; i < 12; i += 1) {
    await store.appendLine('projects/p1/history.jsonl', { i }, { maxLines: 10 });
  }
  const lines = await store.readLines('projects/p1/history.jsonl', { limit: 100 });
  assertEqual(lines.length, 10, 'trimmed to cap');
  assertEqual(lines[0].i, 11, 'newest first');
});

await test('store: a corrupt log line is skipped, not fatal', async () => {
  await fs.appendFile(path.join(SCRATCH, 'projects/p1/history.jsonl'), '{ truncated\n');
  const lines = await store.readLines('projects/p1/history.jsonl');
  assert(lines.length > 0, 'still returns the good lines');
});

await test('store: migration runs and snapshots first', async () => {
  const migrated = await store.migrateDocument(
    { schemaVersion: 1, requests: [] },
    {
      targetVersion: 2,
      label: 'project.json',
      migrations: { 1: (doc) => ({ ...doc, schemaVersion: 2, tags: [] }) },
    },
  );
  assertEqual(migrated.schemaVersion, 2, 'version bumped');
  assert(Array.isArray(migrated.tags), 'migration applied');

  const backups = await fs.readdir(path.join(SCRATCH, 'backups'));
  assertEqual(backups.length, 1, 'a pre-migration snapshot was taken');
});

await test('store: refuses to downgrade newer data', async () => {
  let threw = false;
  try {
    await store.migrateDocument(
      { schemaVersion: 99 },
      { targetVersion: 2, label: 'project.json', migrations: {} },
    );
  } catch {
    threw = true;
  }
  assert(threw, 'newer schema must refuse to load rather than be overwritten');
});

await test('store: a migration that does not advance the version fails instead of looping', async () => {
  let threw = false;
  try {
    await store.migrateDocument(
      { schemaVersion: 1 },
      {
        targetVersion: 3,
        label: 'project.json',
        migrations: { 1: (doc) => ({ ...doc, schemaVersion: 1 }) },
      },
    );
  } catch {
    threw = true;
  }
  assert(threw, 'a non-advancing migration must throw, not hang');
});

await test('store: remove cancels a pending write', async () => {
  store.save('projects/p1/doomed.json', { x: 1 }, { debounceMs: 5000 });
  await store.remove('projects/p1/doomed.json');
  await sleep(20);
  assertEqual(await store.exists('projects/p1/doomed.json'), false, 'should stay deleted');
});

/* ---------------------------------------------------------------- *
 * vars.js
 * ---------------------------------------------------------------- */

const scope = vars.buildScope({
  projectVars: [{ key: 'baseUrl', value: 'https://api.example.com' }],
  envVars: [
    { key: 'baseUrl', value: 'https://staging.example.com' },
    { key: 'token', value: crypto.encrypt('sk-secret-value-1234'), secret: true },
    { key: 'disabled', value: 'nope', enabled: false },
    { key: 'authHeader', value: 'Bearer {{token}}' },
  ],
  captures: { userId: 42 },
});

await test('vars: environment overrides project', () => {
  assertEqual(vars.interpolate('{{baseUrl}}/v1', scope).text, 'https://staging.example.com/v1');
});

await test('vars: secrets are decrypted for sending', () => {
  const r = vars.interpolate('{{token}}', scope);
  assertEqual(r.text, 'sk-secret-value-1234', 'decrypted at send time');
  assertEqual(r.secretsUsed[0], 'token', 'secret usage is reported');
});

await test('vars: nested variables resolve', () => {
  assertEqual(vars.interpolate('{{authHeader}}', scope).text, 'Bearer sk-secret-value-1234');
});

await test('vars: captures are available', () => {
  assertEqual(vars.interpolate('/users/{{userId}}', scope).text, '/users/42');
});

await test('vars: unknown variables are reported, not silently blanked', () => {
  const r = vars.interpolate('{{basUrl}}/v1', scope);
  assertEqual(r.missing[0], 'basUrl', 'typo reported');
  assertEqual(r.text, '{{basUrl}}/v1', 'left intact so the mistake is visible');
});

await test('vars: disabled variables do not resolve', () => {
  assertEqual(vars.interpolate('{{disabled}}', scope).missing[0], 'disabled');
});

await test('vars: secret values are masked everywhere they appear', () => {
  const masked = vars.maskText(
    'Authorization: Bearer sk-secret-value-1234 (echoed: sk-secret-value-1234)',
    scope,
  );
  assert(!masked.includes('sk-secret-value-1234'), 'no plaintext secret may survive masking');
  assertEqual(masked.split(vars.MASK).length - 1, 2, 'every occurrence masked');
});

await test('vars: masking reaches nested structures', () => {
  const masked = vars.maskDeep(
    { headers: { authorization: 'Bearer sk-secret-value-1234' }, list: ['sk-secret-value-1234'] },
    scope,
  );
  assert(!JSON.stringify(masked).includes('sk-secret-value-1234'), 'nested secret masked');
});

await test('vars: non-secret values are not masked', () => {
  assertEqual(
    vars.maskText('https://staging.example.com', scope),
    'https://staging.example.com',
    'only secrets are masked',
  );
});

await test('vars: an undecryptable secret is reported per variable, not fatal', () => {
  const foreignKey = nodeCrypto.createHash('sha256').update('another-machine').digest();
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', foreignKey, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update('their-secret', 'utf8'), cipher.final()]);
  const foreign = 'enc:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');

  const broken = vars.buildScope({
    envVars: [
      { key: 'good', value: 'https://api.example.com' },
      { key: 'bad', value: foreign, secret: true },
    ],
  });

  // The healthy variable must still work.
  assertEqual(vars.interpolate('{{good}}', broken).text, 'https://api.example.com');

  const r = vars.interpolate('{{bad}}', broken);
  assertEqual(r.errors.length, 1, 'the failure is reported when referenced');
  assert(r.errors[0].startsWith('bad:'), 'names the offending variable');
});

await test('vars: masking covers object keys as well as values', () => {
  const masked = vars.maskDeep({ 'sk-secret-value-1234': 'x' }, scope);
  assert(!JSON.stringify(masked).includes('sk-secret-value-1234'), 'key must be masked too');
});

await test('vars: colliding masked keys do not drop values', () => {
  const s2 = vars.buildScope({
    envVars: [
      { key: 'a', value: 'secret-alpha-value', secret: true },
      { key: 'b', value: 'secret-beta-value', secret: true },
    ],
  });
  const masked = vars.maskDeep({ 'secret-alpha-value': 1, 'secret-beta-value': 2 }, s2);
  assertEqual(Object.keys(masked).length, 2, 'both entries must survive masking');
});

await test('vars: interpolateDeep walks objects and arrays', () => {
  const r = vars.interpolateDeep({ url: '{{baseUrl}}/x', tags: ['{{userId}}'] }, scope);
  assertEqual(r.value.url, 'https://staging.example.com/x');
  assertEqual(r.value.tags[0], '42');
});

/* ---------------------------------------------------------------- *
 * exec/bodies.js
 * ---------------------------------------------------------------- */

const bodies = await import('../server/exec/bodies.js');

await test('bodies: json sets its content type and passes the text through', () => {
  const r = bodies.buildBody({ type: 'json', content: '{"a":1}' });
  assertEqual(r.contentType, 'application/json');
  assertEqual(r.payload, '{"a":1}');
  assertEqual(r.warnings.length, 0, 'valid JSON should not warn');
});

await test('bodies: malformed json warns but is still sent', () => {
  const r = bodies.buildBody({ type: 'json', content: '{"a":' });
  assertEqual(r.payload, '{"a":', 'must be sent as-is — it is a valid test case');
  assert(r.warnings.length === 1, 'should warn');
});

await test('bodies: form encodes and skips disabled fields', () => {
  const r = bodies.buildBody({
    type: 'form',
    fields: [
      { key: 'a', value: '1' },
      { key: 'b', value: 'x y' },
      { key: 'c', value: '3', enabled: false },
    ],
  });
  assertEqual(r.payload, 'a=1&b=x+y');
  assertEqual(r.contentType, 'application/x-www-form-urlencoded');
});

await test('bodies: multipart leaves the content type to fetch (boundary)', () => {
  const r = bodies.buildBody({ type: 'multipart', fields: [{ key: 'a', value: '1' }] });
  assertEqual(r.contentType, null, 'setting it manually would break the boundary');
  assert(r.payload instanceof FormData, 'should build FormData');
});

await test('bodies: graphql wraps query and variables', () => {
  const r = bodies.buildBody({ type: 'graphql', query: '{ me }', variables: '{"id":1}' });
  assertEqual(JSON.parse(r.payload).query, '{ me }');
  assertEqual(JSON.parse(r.payload).variables.id, 1);
});

await test('bodies: graphql with bad variables warns and sends an empty object', () => {
  const r = bodies.buildBody({ type: 'graphql', query: '{ me }', variables: 'nope' });
  assertEqual(Object.keys(JSON.parse(r.payload).variables).length, 0);
  assert(r.warnings.length === 1, 'should warn');
});

await test('bodies: textual content types are detected', () => {
  assertEqual(bodies.isTextualContentType('application/json; charset=utf-8'), true);
  assertEqual(bodies.isTextualContentType('application/problem+json'), true);
  assertEqual(bodies.isTextualContentType('text/html'), true);
  assertEqual(bodies.isTextualContentType('image/png'), false);
  assertEqual(bodies.isTextualContentType(null), true, 'undeclared is assumed textual');
});

/* ---------------------------------------------------------------- *
 * Secret handling — renaming must not destroy a stored secret
 * ---------------------------------------------------------------- */

const model = await import('../server/model.js');

await test('model: renaming a secret keeps its stored value', () => {
  const stored = model.encryptSecrets(
    [{ key: 'token', value: 'real-secret', secret: true, enabled: true }],
    [],
  );
  assert(stored[0].id, 'the server assigned an id');
  assert(stored[0].value.startsWith('enc:'), 'and encrypted the value');

  // What the UI sends back after a rename: same id, new key, value still the mask.
  const renamed = model.encryptSecrets(
    [{ ...stored[0], key: 'apiToken', value: vars.MASK }],
    stored,
  );

  assertEqual(renamed[0].key, 'apiToken', 'the rename applied');
  assertEqual(renamed[0].value, stored[0].value, 'and the stored secret survived it');
});

await test('model: a rename and a reorder in the same save both survive', () => {
  const stored = model.encryptSecrets(
    [
      { key: 'a', value: 'secret-a', secret: true, enabled: true },
      { key: 'b', value: 'secret-b', secret: true, enabled: true },
    ],
    [],
  );

  // Reversed order and both renamed — matching on key alone could not survive this.
  const saved = model.encryptSecrets(
    [
      { ...stored[1], key: 'bee', value: vars.MASK },
      { ...stored[0], key: 'ay', value: vars.MASK },
    ],
    stored,
  );

  assertEqual(saved[0].value, stored[1].value, 'b kept its own secret under its new name');
  assertEqual(saved[1].value, stored[0].value, 'a kept its own secret under its new name');
});

await test('model: an unmatched mask is refused rather than silently wiped', () => {
  // A client that renames without sending the id has nothing to match. Storing an empty value
  // here would destroy a credential the user cannot read back — so it must fail loudly.
  let message = '';
  try {
    model.encryptSecrets(
      [{ key: 'renamed', value: vars.MASK, secret: true }],
      [{ key: 'original', value: 'enc:whatever', secret: true }],
    );
  } catch (err) {
    message = err.message;
  }
  assert(message.includes('renamed'), `should name the variable, got: ${message}`);
  assert(message.includes('Re-enter'), 'and say what to do about it');
});

await test('model: a genuinely new empty secret is still allowed', () => {
  // Empty is not the mask: it means "I have not filled this in yet", which is normal.
  const saved = model.encryptSecrets([{ key: 'later', value: '', secret: true }], []);
  assertEqual(saved[0].value, '', 'stored empty');
  assert(saved[0].id, 'and still got an id');
});

await test('model: the v1 migration backfills variable ids without touching values', () => {
  const v1 = {
    schemaVersion: 1,
    variables: [{ key: 'token', value: 'enc:abc', secret: true, enabled: true }],
  };
  const migrated = model.projectMigrations[1](v1);

  assertEqual(migrated.schemaVersion, 2, 'version bumped');
  assert(migrated.variables[0].id, 'id assigned');
  assertEqual(migrated.variables[0].value, 'enc:abc', 'the encrypted value is untouched');

  const envs = model.environmentsMigrations[1]({
    schemaVersion: 1,
    environments: [{ id: 'e1', name: 'local', variables: [{ key: 'k', value: 'v' }] }],
  });
  assert(envs.environments[0].variables[0].id, 'environment variables get ids too');
});

/* ---------------------------------------------------------------- *
 * Dynamic variables
 * ---------------------------------------------------------------- */

await test('vars: {{$uuid}} is one value per send, not per occurrence', () => {
  // Two occurrences in one request must agree, or a body that correlates with a header is
  // broken and the recorded run shows a value that was never sent.
  const scope = vars.buildScope({});
  const resolved = vars.interpolate('a={{$uuid}} b={{$uuid}}', scope).text;
  const [a, b] = resolved.replace('a=', '').split(' b=');

  assertEqual(a, b, 'the same within one scope');
  assert(/^[0-9a-f-]{36}$/.test(a), `should look like a uuid, got ${a}`);
});

await test('vars: a new send gets a new value', () => {
  const first = vars.interpolate('{{$uuid}}', vars.buildScope({})).text;
  const second = vars.interpolate('{{$uuid}}', vars.buildScope({})).text;
  assert(first !== second, 'a fresh scope generates afresh');
});

await test('vars: a variable of the same name pins a dynamic value', () => {
  // This is how the retry path is tested: an idempotency key only means something if you can
  // also send the same one twice deliberately.
  const scope = vars.buildScope({ envVars: [{ key: '$uuid', value: 'PINNED', enabled: true }] });
  assertEqual(vars.interpolate('{{$uuid}}', scope).text, 'PINNED', 'the variable wins');
});

await test('vars: the other generated values resolve to their expected shapes', () => {
  const scope = vars.buildScope({});
  assert(/^\d{10}$/.test(vars.interpolate('{{$timestamp}}', scope).text), 'unix seconds');
  assert(/^\d{4}-\d{2}-\d{2}T/.test(vars.interpolate('{{$isoTimestamp}}', scope).text), 'iso 8601');
  assert(/^\d+$/.test(vars.interpolate('{{$randomInt}}', scope).text), 'an integer');
});

await test('vars: an unknown $name is still reported missing rather than invented', () => {
  const result = vars.interpolate('{{$nope}}', vars.buildScope({}));
  assertEqual(result.missing.join(','), '$nope', 'reported, not silently blanked');
  assertEqual(result.text, '{{$nope}}', 'and left alone');
});

await fs.rm(SCRATCH, { recursive: true, force: true });
summarise('unit');
