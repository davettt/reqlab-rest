/**
 * BYOK provider adapters.
 *
 * Two providers, one shape. Each takes a system prompt, a user message, and a JSON schema,
 * and returns parsed JSON — the schema is enforced by the provider's own structured-output
 * mechanism (tool use for Anthropic, response_format for OpenAI) rather than by asking nicely
 * in the prompt and hoping.
 *
 * Model IDs come from build-policy/registry.json and must stay in step with it; they are not
 * guesses and must not be "updated" from memory.
 */

export const MODELS = {
  anthropic: {
    fast: 'claude-haiku-4-5-20251001',
    smart: 'claude-sonnet-4-6',
  },
  openai: {
    fast: 'gpt-5.4-nano-2026-03-17',
    smart: 'gpt-5.4-mini-2026-03-17',
  },
};

export const PROVIDERS = Object.keys(MODELS);

export class AiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AiError';
    this.status = 400;
  }
}

const TIMEOUT_MS = 120_000;

/**
 * @param {{provider: string, tier: string, apiKey: string}} config
 * @param {{system: string, user: string, schema: object, schemaName: string}} request
 * @returns {Promise<object>} the parsed structured output
 */
export async function completeJson(config, request) {
  const model = MODELS[config.provider]?.[config.tier ?? 'smart'];
  if (!model) throw new AiError(`Unknown provider or tier: ${config.provider}/${config.tier}`);
  if (!config.apiKey) throw new AiError('No API key configured for that provider.');

  return config.provider === 'anthropic'
    ? anthropic(config.apiKey, model, request)
    : openai(config.apiKey, model, request);
}

/* ---------------------------------------------------------------- *
 * Anthropic
 * ---------------------------------------------------------------- */

async function anthropic(apiKey, model, { system, user, schema, schemaName }) {
  const res = await post(
    'https://api.anthropic.com/v1/messages',
    {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    {
      model,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: user }],
      // Tool use as the structured-output mechanism: the schema is enforced by the API,
      // so the result parses or the call fails — no scraping JSON out of prose.
      tools: [
        { name: schemaName, description: 'Return the extracted result', input_schema: schema },
      ],
      tool_choice: { type: 'tool', name: schemaName },
    },
    'Anthropic',
  );

  const toolUse = res.content?.find((block) => block.type === 'tool_use');
  if (!toolUse) throw new AiError('The model did not return a structured result.');
  return toolUse.input;
}

/* ---------------------------------------------------------------- *
 * OpenAI
 * ---------------------------------------------------------------- */

async function openai(apiKey, model, { system, user, schema, schemaName }) {
  const res = await post(
    'https://api.openai.com/v1/chat/completions',
    { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, schema, strict: false },
      },
    },
    'OpenAI',
  );

  const text = res.choices?.[0]?.message?.content;
  if (!text) throw new AiError('The model returned an empty response.');
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('The model did not return valid JSON.');
  }
}

/* ---------------------------------------------------------------- *
 * Transport
 * ---------------------------------------------------------------- */

async function post(url, headers, body, label) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new AiError(`${label} did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new AiError(`Could not reach ${label}: ${err.message}`);
  }

  const text = await res.text();

  if (!res.ok) {
    // The provider's own message is the useful part (bad key, rate limit, model not
    // available to this account) — but it is echoed back trimmed, and the key never appears
    // in it because it was only ever sent in a header.
    let detail = text.slice(0, 400);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.error?.message ?? detail;
    } catch {
      /* keep the raw text */
    }

    if (res.status === 401 || res.status === 403) {
      throw new AiError(`${label} rejected the API key: ${detail}`);
    }
    if (res.status === 429) {
      throw new AiError(`${label} rate limit or quota reached: ${detail}`);
    }
    throw new AiError(`${label} returned HTTP ${res.status}: ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new AiError(`${label} returned a response that was not JSON.`);
  }
}
