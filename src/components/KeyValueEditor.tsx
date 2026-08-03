import type { KeyValue } from '../types';

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

const CUSTOM = '__custom__';

/**
 * Editable key/value rows with a permanent blank row at the end, so adding an entry never
 * needs an "add" button — the same interaction Postman and Insomnia use.
 *
 * A row imported with documented `options` renders as a dropdown rather than a free-text box:
 * when the docs say a parameter accepts JSON or XML and nothing else, making the user recall
 * and retype that is a pointless source of typos. "Other…" is always available, because an
 * API can accept more than its documentation admits.
 */
export default function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder = 'Name',
  valuePlaceholder = 'Value',
}: Props) {
  const withBlank = [...rows, { key: '', value: '', enabled: true }];

  const update = (index: number, patch: Partial<KeyValue>) => {
    const next = withBlank.map((row, i) => (i === index ? { ...row, ...patch } : row));
    onChange(next.filter((row, i) => (row.key || row.value) && i < next.length));
  };

  return (
    <div className="flex flex-col gap-1">
      {withBlank.map((row, index) => {
        const options = row.options ?? [];
        const usesSelect = options.length > 0;
        const valueIsListed = options.includes(row.value);

        return (
          <div key={index} className="flex flex-col">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={row.enabled !== false}
                onChange={(e) => update(index, { enabled: e.target.checked })}
                aria-label={`Enable ${row.key || 'row'}`}
                className="accent-sky-500"
                disabled={!row.key && !row.value}
              />
              <input
                value={row.key}
                onChange={(e) => update(index, { key: e.target.value })}
                placeholder={keyPlaceholder}
                title={row.description}
                className="w-1/3 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
              />

              {usesSelect ? (
                <select
                  value={valueIsListed ? row.value : CUSTOM}
                  onChange={(e) =>
                    update(index, { value: e.target.value === CUSTOM ? '' : e.target.value })
                  }
                  className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200 focus:border-sky-600 focus:outline-none"
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                  <option value={CUSTOM}>Other…</option>
                </select>
              ) : (
                <input
                  value={row.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                  placeholder={valuePlaceholder}
                  className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
                />
              )}

              <button
                type="button"
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
                className="px-1 text-slate-600 hover:text-rose-400 disabled:opacity-0"
                disabled={index >= rows.length}
                aria-label="Remove row"
              >
                ×
              </button>
            </div>

            {/* A value outside the documented set still needs somewhere to be typed. */}
            {usesSelect && !valueIsListed && (
              <div className="mt-1 flex items-center gap-2 pl-6">
                <span className="w-1/3" />
                <input
                  autoFocus
                  value={row.value}
                  onChange={(e) => update(index, { value: e.target.value })}
                  placeholder="Custom value"
                  className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
                />
                <span className="w-5" />
              </div>
            )}

            {row.description && (
              <p className="mt-0.5 pl-6 text-xs text-slate-600">
                {row.description}
                {options.length > 0 && (
                  <span className="text-slate-700"> · accepts {options.join(', ')}</span>
                )}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
