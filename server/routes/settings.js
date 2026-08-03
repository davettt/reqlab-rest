/**
 * Settings: AI provider configuration.
 *
 * The API key is treated exactly like an environment secret — encrypted at rest with the
 * machine key, masked on read, and a masked value sent back on save means "keep what you
 * have". The browser never receives the key it just saved.
 */
import express from 'express';
import { z } from 'zod';
import { encrypt, decrypt } from '../crypto.js';
import { MASK } from '../vars.js';
import { MODELS, PROVIDERS } from '../ai/providers.js';
import * as store from '../store.js';

export const router = express.Router();

const SETTINGS_FILE = 'settings.json';

const settingsInput = z.object({
  provider: z.enum(['anthropic', 'openai']).optional(),
  tier: z.enum(['fast', 'smart']).optional(),
  apiKeys: z
    .object({
      anthropic: z.string().max(500).optional(),
      openai: z.string().max(500).optional(),
    })
    .optional(),
});

async function load() {
  return (
    (await store.readJson(SETTINGS_FILE, null)) ?? {
      provider: 'anthropic',
      tier: 'smart',
      apiKeys: {},
    }
  );
}

/** Never returns key material — only whether each provider has one. */
function publicView(settings) {
  return {
    provider: settings.provider,
    tier: settings.tier,
    configured: {
      anthropic: Boolean(settings.apiKeys?.anthropic),
      openai: Boolean(settings.apiKeys?.openai),
    },
    models: MODELS,
    providers: PROVIDERS,
  };
}

router.get('/', async (_req, res, next) => {
  try {
    res.json(publicView(await load()));
  } catch (err) {
    next(err);
  }
});

router.patch('/', async (req, res, next) => {
  try {
    const input = settingsInput.parse(req.body);
    const current = await load();

    const apiKeys = { ...current.apiKeys };
    for (const [provider, value] of Object.entries(input.apiKeys ?? {})) {
      if (value === undefined) continue;
      // The mask means "unchanged"; an empty string means "remove".
      if (value === MASK) continue;
      apiKeys[provider] = value ? encrypt(value) : '';
    }

    const updated = {
      provider: input.provider ?? current.provider,
      tier: input.tier ?? current.tier,
      apiKeys,
    };
    await store.writeJson(SETTINGS_FILE, updated);
    res.json(publicView(updated));
  } catch (err) {
    next(err);
  }
});

/** Read the decrypted config for server-side use. Never exposed over HTTP. */
export async function aiConfig(overrides = {}) {
  const settings = await load();
  const provider = overrides.provider ?? settings.provider;
  const stored = settings.apiKeys?.[provider];

  return {
    provider,
    tier: overrides.tier ?? settings.tier ?? 'smart',
    apiKey: stored ? decrypt(stored) : '',
  };
}
