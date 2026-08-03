import { useState } from 'react';
import { useStore } from '../stores/appStore';
import type { ImportPreview } from '../types';
import { methodTone } from '../types';

const input =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none';

/**
 * Import in two steps: preview, then apply.
 *
 * The preview is the point of the thing. An import can add dozens of requests and a new
 * environment, so the user sees exactly what would be created — and can deselect any of it —
 * before anything is written.
 */
export default function ImportDialog({ onClose }: { onClose: () => void }) {
  const { project, environments, environmentId, importPreview, importApply } = useStore();

  const [mode, setMode] = useState<'url' | 'paste'>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const [useAi, setUseAi] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [environmentName, setEnvironmentName] = useState('Imported');
  // Defaults to the environment already in use, so a repeat import tops up what you have
  // instead of creating another one.
  const [targetEnvId, setTargetEnvId] = useState<string>(environmentId ?? '');
  const [done, setDone] = useState<string | null>(null);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    const result = await importPreview(mode === 'url' ? { url, useAi } : { text, useAi });
    setBusy(false);

    if ('error' in result) {
      setError(result.error);
      setNeedsKey(Boolean(result.needsKey));
      // Offering the toggle at the moment it becomes relevant beats hiding it in advance.
      if (result.unstructured) setUseAi(true);
      return;
    }
    setPreview(result);
    setChosen(new Set(result.requests.map((_, i) => i)));
    setEnvironmentName(result.info.title || 'Imported');
  };

  const apply = async () => {
    if (!preview || !project) return;
    setBusy(true);
    const message = await importApply({
      projectId: project.id,
      environmentId: targetEnvId || null,
      environmentName,
      requests: preview.requests.filter((_, i) => chosen.has(i)),
      variables: preview.variables,
    });
    setBusy(false);
    if (message) setDone(message);
  };

  const toggle = (index: number) => {
    const next = new Set(chosen);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    setChosen(next);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/80 p-6">
      <div className="flex w-full max-w-3xl flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Import requests</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {done ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-emerald-400">{done}</p>
            <button
              type="button"
              onClick={onClose}
              className="self-start rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500"
            >
              Done
            </button>
          </div>
        ) : !preview ? (
          <>
            <div className="flex gap-2 text-xs">
              {(['url', 'paste'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`rounded px-2 py-1 ${
                    mode === m
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {m === 'url' ? 'From a URL' : 'Paste a document'}
                </button>
              ))}
            </div>

            {mode === 'url' ? (
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://api.example.com/openapi.json"
                className={`${input} font-mono`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runPreview();
                }}
              />
            ) : (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste an OpenAPI or Swagger spec, a Postman collection, or a HAR file"
                className={`${input} h-56 font-mono`}
                spellCheck={false}
              />
            )}

            <p className="text-xs text-slate-600">
              OpenAPI 3, Swagger 2 (JSON or YAML), Postman v2 collections and HAR captures are
              parsed exactly — no AI involved. Credentials found in an export are replaced with
              empty secret variables rather than imported.
            </p>

            {error && (
              <div className="rounded border border-rose-900 bg-rose-950/40 p-2 text-xs text-rose-300">
                {error}
                {needsKey && (
                  <p className="mt-1 text-slate-400">
                    Add a provider key under Settings, then try again.
                  </p>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(e) => setUseAi(e.target.checked)}
                className="accent-amber-500"
              />
              Use AI for written documentation (costs a call to your provider, and can be wrong)
            </label>

            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={busy || (mode === 'url' ? !url : !text)}
              className="self-start rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
            >
              {busy ? 'Reading…' : 'Preview'}
            </button>
          </>
        ) : (
          <>
            <div className="text-xs text-slate-400">
              <span className="text-slate-200">{preview.info.title}</span>{' '}
              {preview.info.version && <span>v{preview.info.version}</span>}{' '}
              <span className="text-slate-600">({preview.info.format})</span>
              <span className="ml-2">
                {preview.summary.requests} requests, {preview.summary.variables} variables
                {preview.summary.secrets > 0 && `, ${preview.summary.secrets} secret`}
              </span>
            </div>

            {preview.info.description && (
              <p className="text-xs text-slate-500">{preview.info.description}</p>
            )}

            {preview.redirects.length > 0 && (
              <p className="text-xs text-amber-400">
                That URL redirected: {preview.redirects.join(' , ')}
              </p>
            )}

            {preview.source === 'ai' && (
              <p className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-xs text-amber-300">
                These were inferred from prose by a language model. Check each one against the
                documentation before relying on it.
              </p>
            )}

            {preview.warnings.length > 0 && (
              <ul className="rounded border border-amber-900/60 bg-amber-950/20 p-2 text-xs text-amber-300">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="max-h-72 overflow-auto rounded border border-slate-800">
              {preview.requests.map((request, index) => (
                <label
                  key={index}
                  className="flex cursor-pointer items-center gap-2 border-b border-slate-800/60 px-2 py-1 text-xs hover:bg-slate-800/40"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(index)}
                    onChange={() => toggle(index)}
                    className="accent-sky-500"
                  />
                  <span className={`w-14 shrink-0 font-mono ${methodTone(request.method)}`}>
                    {request.method}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-300">{request.name}</span>
                  <span className="hidden truncate font-mono text-slate-600 sm:block">
                    {request.url}
                  </span>
                </label>
              ))}
            </div>

            {preview.variables.length > 0 && (
              <div className="flex flex-col gap-1 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <span>Variables go to</span>
                  <select
                    value={targetEnvId}
                    onChange={(e) => setTargetEnvId(e.target.value)}
                    className={`${input} px-1 py-0.5 text-xs`}
                  >
                    {environments.map((env) => (
                      <option key={env.id} value={env.id}>
                        {env.name}
                      </option>
                    ))}
                    <option value="">＋ a new environment</option>
                  </select>
                  {!targetEnvId && (
                    <input
                      value={environmentName}
                      onChange={(e) => setEnvironmentName(e.target.value)}
                      placeholder="Environment name"
                      className={`${input} w-44 px-1 py-0.5 text-xs`}
                    />
                  )}
                </div>

                <p className="text-slate-500">{preview.variables.map((v) => v.key).join(', ')}</p>

                {targetEnvId ? (
                  <p className="text-slate-600">
                    Existing values are kept — only variables you do not already have are added.
                  </p>
                ) : (
                  <p className="text-slate-600">
                    Environments are deployment targets (dev, staging, production) holding the same
                    variables with different values. One is usually enough.
                  </p>
                )}

                {preview.summary.secrets > 0 && (
                  <p className="text-slate-500">
                    Secret variables are created empty — fill them in after importing.
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void apply()}
                disabled={busy || !chosen.size || !project}
                className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
              >
                {busy
                  ? 'Importing…'
                  : `Import ${chosen.size} request${chosen.size === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-xs text-slate-500 hover:text-slate-300"
              >
                Back
              </button>
              {!project && <span className="text-xs text-amber-400">Open a project first.</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
