import { useEffect, useState } from 'react';

interface BuildStatus {
  stale: boolean;
  version: string;
}

export default function App() {
  const [status, setStatus] = useState<BuildStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/build-status')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold text-slate-100">ReqLab REST</h1>
      <p className="max-w-md text-sm text-slate-400">
        A local REST client with an API-verification lab. The workspace UI lands in the next phase.
      </p>
      {status && (
        <p className="text-xs text-slate-500">
          server v{status.version}
          {status.stale && <span className="ml-2 text-amber-400">build is stale</span>}
        </p>
      )}
      {error && <p className="text-xs text-rose-400">server unreachable: {error}</p>}
    </div>
  );
}
