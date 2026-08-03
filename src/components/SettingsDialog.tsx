import { useEffect, useState } from 'react';
import { useStore } from '../stores/appStore';

const input =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none';

/**
 * A masked input that is NOT type="password".
 *
 * A password input makes Chrome (and every password manager) offer to save the value as an
 * account credential — which would put an API key into the browser's password vault and sync
 * it to the user's cloud account. That directly contradicts the point of storing it encrypted
 * and locally. The masking is done with -webkit-text-security instead, which looks identical
 * and carries none of that meaning.
 */
const MASKED_INPUT_PROPS = {
  type: 'text' as const,
  autoComplete: 'off' as const,
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': '',
  'data-form-type': 'other',
};

const maskedClass = '[-webkit-text-security:disc]';

/**
 * AI provider settings.
 *
 * The key is write-only from the browser's perspective: the server stores it encrypted and
 * only ever reports *whether* a provider is configured, never the value. There is deliberately
 * no way to read a saved key back out of the UI.
 */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, loadSettings, saveSettings } = useStore();
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openaiKey, setOpenaiKey] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  if (!settings) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80">
        <p className="text-sm text-slate-400">Loading…</p>
      </div>
    );
  }

  const save = async () => {
    await saveSettings({
      provider: settings.provider,
      tier: settings.tier,
      apiKeys: {
        ...(anthropicKey ? { anthropic: anthropicKey } : {}),
        ...(openaiKey ? { openai: openaiKey } : {}),
      },
    });
    setAnthropicKey('');
    setOpenaiKey('');
    setSaved(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/80 p-6">
      <div className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">AI settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <p className="text-xs text-slate-500">
          Used only for importing written documentation. Every other feature — including OpenAPI,
          Postman and HAR import — works without a key and never contacts a model.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 shrink-0 text-slate-400">Provider</span>
          <select
            value={settings.provider}
            onChange={(e) =>
              void saveSettings({ provider: e.target.value as 'anthropic' | 'openai' })
            }
            className={`${input} flex-1`}
          >
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 shrink-0 text-slate-400">Model</span>
          <select
            value={settings.tier}
            onChange={(e) => void saveSettings({ tier: e.target.value as 'fast' | 'smart' })}
            className={`${input} flex-1`}
          >
            <option value="smart">Smart — {settings.models[settings.provider].smart}</option>
            <option value="fast">Fast — {settings.models[settings.provider].fast}</option>
          </select>
        </label>

        <p className="text-xs text-slate-600">
          Reading endpoints out of prose is where a fast model tends to produce plausible but wrong
          requests, so smart is the default.
        </p>

        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 shrink-0 text-slate-400">Anthropic</span>
          <input
            {...MASKED_INPUT_PROPS}
            name="anthropic-api-key"
            value={anthropicKey}
            onChange={(e) => setAnthropicKey(e.target.value)}
            placeholder={settings.configured.anthropic ? '•••• (saved)' : 'sk-ant-…'}
            className={`${input} ${maskedClass} flex-1 font-mono`}
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 shrink-0 text-slate-400">OpenAI</span>
          <input
            {...MASKED_INPUT_PROPS}
            name="openai-api-key"
            value={openaiKey}
            onChange={(e) => setOpenaiKey(e.target.value)}
            placeholder={settings.configured.openai ? '•••• (saved)' : 'sk-…'}
            className={`${input} ${maskedClass} flex-1 font-mono`}
          />
        </label>

        <p className="text-xs text-slate-600">
          Keys are encrypted at rest with your machine key and never sent to this page again — leave
          a field blank to keep the saved one.
        </p>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={!anthropicKey && !openaiKey}
            className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
          >
            Save key
          </button>
          {saved && <span className="text-xs text-emerald-400">Saved</span>}
        </div>
      </div>
    </div>
  );
}
