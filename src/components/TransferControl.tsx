import { useState } from 'react';
import { useStore } from '../stores/appStore';

interface Props {
  label: string;
  requestIds?: string[];
  environmentIds?: string[];
}

/**
 * Move or copy a request or environment into another project.
 *
 * Exists because filing something under the wrong project is easy to do and, without this,
 * impossible to undo except by retyping it — including any secret, which cannot be read back
 * out of the environment it was saved to.
 */
export default function TransferControl({ label, requestIds, environmentIds }: Props) {
  const { projects, project, transfer } = useStore();
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const others = projects.filter((p) => p.id !== project?.id);
  if (!others.length) return null;

  const run = async (mode: 'copy' | 'move') => {
    if (!targetId) return;
    const message = await transfer({ targetProjectId: targetId, mode, requestIds, environmentIds });
    setDone(message);
    setOpen(false);
  };

  if (done) {
    return (
      <span className="flex items-center gap-2 text-xs text-emerald-400">
        {done}
        <button type="button" onClick={() => setDone(null)} className="text-slate-500">
          ×
        </button>
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-slate-500 hover:text-slate-200"
      >
        {label}
      </button>
    );
  }

  return (
    <span className="flex items-center gap-1 text-xs">
      <select
        value={targetId}
        onChange={(e) => setTargetId(e.target.value)}
        className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-xs text-slate-200"
      >
        <option value="">Choose project…</option>
        {others.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void run('copy')}
        disabled={!targetId}
        className="text-sky-400 hover:text-sky-300 disabled:opacity-40"
      >
        Copy
      </button>
      <button
        type="button"
        onClick={() => void run('move')}
        disabled={!targetId}
        className="text-amber-400 hover:text-amber-300 disabled:opacity-40"
      >
        Move
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-slate-500">
        Cancel
      </button>
    </span>
  );
}
