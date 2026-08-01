import type { KeyValue } from '../types';

interface Props {
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/**
 * Editable key/value rows with a permanent blank row at the end, so adding an entry never
 * needs an "add" button — the same interaction Postman and Insomnia use.
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
    // Drop rows the user emptied out, but keep the trailing blank from being saved.
    onChange(next.filter((row, i) => (row.key || row.value) && i < next.length));
  };

  return (
    <div className="flex flex-col gap-1">
      {withBlank.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
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
            className="w-1/3 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
          <input
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none"
          />
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
      ))}
    </div>
  );
}
