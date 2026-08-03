import { useState } from 'react';
import { MASK, type Variable } from '../types';

interface Props {
  variables: Variable[];
  onSave: (variables: Variable[]) => void;
}

const input =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none';

const blank = (): Variable => ({ key: '', value: '', enabled: true, secret: false });

/**
 * Environment variable editor.
 *
 * Two deliberate differences from the plain key/value editor:
 *
 *  1. Each row carries its own "secret" toggle, available *before* the row is ever saved. The
 *     earlier version only offered the toggle for variables that already existed, so a key had
 *     to be written in plaintext first and encrypted afterwards — meaning the real value hit
 *     the disk (and any folder sync) at least once.
 *  2. Edits are local until you press Save, rather than persisting on every keystroke, so a
 *     half-typed credential is never written at all.
 */
export default function VariableEditor({ variables, onSave }: Props) {
  // Starts with one empty row only when there is nothing yet, so the panel is never a dead
  // end — but an existing list does not grow a phantom blank row that looks like a variable.
  const [rows, setRows] = useState<Variable[]>(variables.length ? variables : [blank()]);
  const [dirty, setDirty] = useState(false);

  // Re-sync when the server sends back a saved copy (secrets come back masked). Adjusted
  // during render rather than in an effect: an effect would render once with stale rows and
  // then again with fresh ones, which is the cascading-render pattern React warns about.
  const [seen, setSeen] = useState(variables);
  if (seen !== variables) {
    setSeen(variables);
    setRows(variables.length ? variables : [blank()]);
    setDirty(false);
  }

  const update = (index: number, patch: Partial<Variable>) => {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  };

  const add = () => {
    setRows([...rows, blank()]);
    setDirty(true);
  };

  const remove = (index: number) => {
    const next = rows.filter((_, i) => i !== index);
    setRows(next.length ? next : [blank()]);
    setDirty(true);
  };

  const save = () => {
    onSave(rows.filter((row) => row.key.trim()));
    setDirty(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={row.enabled !== false}
              onChange={(e) => update(index, { enabled: e.target.checked })}
              disabled={!row.key}
              aria-label={`Enable ${row.key || 'variable'}`}
              className="accent-sky-500"
            />

            <input
              value={row.key}
              onChange={(e) => update(index, { key: e.target.value })}
              placeholder="Variable"
              className={`${input} w-1/3`}
            />

            <input
              value={row.value}
              onChange={(e) => update(index, { value: e.target.value })}
              onFocus={(e) => {
                // A stored secret shows as the mask. Clear it on focus so typing replaces the
                // value instead of appending to "••••" — and leaving without typing keeps it.
                if (row.secret && e.target.value === MASK) update(index, { value: '' });
              }}
              placeholder={row.secret ? 'Secret value' : 'Value'}
              type="text"
              autoComplete="off"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore=""
              data-form-type="other"
              // Masked via CSS rather than type="password": a password input makes the
              // browser offer to save the value as an account credential, which would copy
              // an API key into its vault and sync it to the cloud.
              className={`${input} flex-1 font-mono ${row.secret ? '[-webkit-text-security:disc]' : ''}`}
            />

            <label
              className="flex shrink-0 items-center gap-1 text-xs text-slate-500"
              title="Encrypt this value at rest and never send it to the browser"
            >
              <input
                type="checkbox"
                checked={row.secret}
                onChange={(e) => update(index, { secret: e.target.checked })}
                className="accent-amber-500"
              />
              secret
            </label>

            <button
              type="button"
              onClick={() => remove(index)}
              className="px-1 text-slate-600 hover:text-rose-400"
              aria-label="Remove variable"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={add}
          className="rounded border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:border-slate-500"
        >
          + Add variable
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty}
          className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          Save variables
        </button>
        {dirty && <span className="text-xs text-amber-400">unsaved</span>}
      </div>

      <p className="text-xs text-slate-600">
        Tick <span className="text-slate-500">secret</span> before entering the value: secrets are
        encrypted when saved, and nothing is written to disk until you press Save. Use a variable
        anywhere as <code className="text-slate-500">{'{{name}}'}</code>.
      </p>
    </div>
  );
}
