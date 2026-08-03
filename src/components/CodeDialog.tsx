import { useEffect, useState } from 'react';
import { useStore } from '../stores/appStore';
import type { ApiRequest } from '../types';

const TARGETS = [
  { id: 'curl', label: 'curl' },
  { id: 'fetch', label: 'JS fetch' },
  { id: 'tanstack', label: 'TanStack Query' },
  { id: 'axios', label: 'axios' },
  { id: 'python', label: 'Python' },
] as const;

type Target = (typeof TARGETS)[number]['id'];

/**
 * Code export.
 *
 * Secrets render as environment-variable references by default. Inlining the real value is a
 * deliberate, per-copy choice — a snippet is about to be pasted somewhere, and that somewhere
 * is often a file under version control.
 */
export default function CodeDialog({
  request,
  onClose,
}: {
  request: ApiRequest;
  onClose: () => void;
}) {
  const { generateCode } = useStore();
  const [target, setTarget] = useState<Target>('curl');
  const [inlineSecrets, setInlineSecrets] = useState(false);
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void generateCode(request, target, inlineSecrets).then((result) => {
      if (cancelled) return;
      setCode(result?.code ?? '');
      setNotes(result?.notes ?? []);
      setCopied(false);
    });
    return () => {
      cancelled = true;
    };
  }, [generateCode, request, target, inlineSecrets]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-950/80 p-6">
      <div className="flex w-full max-w-3xl flex-col gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-100">Copy as code</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-500 hover:text-slate-200"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          {TARGETS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTarget(t.id)}
              className={`rounded px-2 py-1 text-xs ${
                target === t.id
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <pre className="max-h-96 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 font-mono text-xs whitespace-pre-wrap text-slate-300">
          {code || 'Generating…'}
        </pre>

        {notes.map((note, i) => (
          <p
            key={i}
            className={`text-xs ${note.includes('Do not commit') ? 'text-amber-400' : 'text-slate-500'}`}
          >
            {note}
          </p>
        ))}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>

          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={inlineSecrets}
              onChange={(e) => setInlineSecrets(e.target.checked)}
              className="accent-amber-500"
            />
            Include real secret values
          </label>
        </div>
      </div>
    </div>
  );
}
