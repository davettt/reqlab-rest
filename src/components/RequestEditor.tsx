import { useState } from 'react';
import { useStore } from '../stores/appStore';
import KeyValueEditor from './KeyValueEditor';
import TransferControl from './TransferControl';
import CodeDialog from './CodeDialog';
import { METHODS, methodTone, type Auth, type BodyType, type Method } from '../types';

const TABS = ['Params', 'Headers', 'Body', 'Auth', 'Assertions'] as const;
type Tab = (typeof TABS)[number];

const BODY_TYPES: BodyType[] = ['none', 'json', 'text', 'xml', 'form', 'graphql'];

const input =
  'rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-600 focus:border-sky-600 focus:outline-none';

export default function RequestEditor() {
  const { draft, dirty, running, updateDraft, saveDraft, send, project } = useStore();
  const [tab, setTab] = useState<Tab>('Params');
  const [showCode, setShowCode] = useState(false);

  if (!draft) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
        Select a request, or create one to get started.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showCode && <CodeDialog request={draft} onClose={() => setShowCode(false)} />}

      {/* Name + save */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <input
          value={draft.name}
          onChange={(e) => updateDraft({ name: e.target.value })}
          className={`${input} flex-1 font-medium`}
          placeholder="Request name"
        />
        <button
          type="button"
          onClick={() => setShowCode(true)}
          disabled={!draft.url}
          className="text-xs text-slate-500 hover:text-slate-200 disabled:opacity-40"
        >
          Code
        </button>
        {draft.id && <TransferControl label="Move / copy…" requestIds={[draft.id]} />}
        {dirty && <span className="text-xs text-amber-400">unsaved</span>}
        <button
          type="button"
          onClick={() => void saveDraft()}
          disabled={!project || !dirty}
          className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500 disabled:opacity-40"
        >
          Save
        </button>
      </div>

      {/* Method + URL + send */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <select
          value={draft.method}
          onChange={(e) => updateDraft({ method: e.target.value as Method })}
          className={`${input} ${methodTone(draft.method)} font-semibold`}
        >
          {METHODS.map((m) => (
            <option key={m} value={m} className="text-slate-200">
              {m}
            </option>
          ))}
        </select>
        <input
          value={draft.url}
          onChange={(e) => updateDraft({ url: e.target.value })}
          placeholder="https://api.example.com/v1/users  or  {{baseUrl}}/users"
          className={`${input} flex-1 font-mono`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={running || !draft.url}
          className="rounded bg-sky-600 px-4 py-1 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          {running ? 'Sending…' : 'Send'}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800 px-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-xs ${
              tab === t
                ? 'border-sky-500 text-slate-100'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t}
            {t === 'Params' && draft.params.length > 0 && ` (${draft.params.length})`}
            {t === 'Headers' && draft.headers.length > 0 && ` (${draft.headers.length})`}
            {t === 'Body' && draft.body.type !== 'none' && ' •'}
            {t === 'Auth' && draft.auth.type !== 'none' && ' •'}
            {t === 'Assertions' && draft.assertions.length > 0 && ` (${draft.assertions.length})`}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'Params' && (
          <div className="flex flex-col gap-2">
            {/* The tab name alone does not say where these end up, which is genuinely
                ambiguous when an API key could belong in either place. */}
            <p className="text-xs text-slate-500">
              Sent as the URL query string — <code className="text-slate-400">?name=value</code>
            </p>
            <KeyValueEditor
              rows={draft.params}
              onChange={(params) => updateDraft({ params })}
              keyPlaceholder="Parameter"
            />
          </div>
        )}

        {tab === 'Headers' && (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-slate-500">Sent as HTTP request headers</p>
            <KeyValueEditor
              rows={draft.headers}
              onChange={(headers) => updateDraft({ headers })}
              keyPlaceholder="Header"
            />
          </div>
        )}

        {tab === 'Body' && <BodyTab />}
        {tab === 'Auth' && <AuthTab />}
        {tab === 'Assertions' && <AssertionsTab />}
      </div>
    </div>
  );
}

function BodyTab() {
  const { draft, updateDraft } = useStore();
  if (!draft) return null;

  return (
    <div className="flex flex-col gap-2">
      <select
        value={draft.body.type}
        onChange={(e) => updateDraft({ body: { ...draft.body, type: e.target.value as BodyType } })}
        className={`${input} w-40`}
      >
        {BODY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      {draft.body.type === 'form' && (
        <KeyValueEditor
          rows={draft.body.fields ?? []}
          onChange={(fields) => updateDraft({ body: { ...draft.body, fields } })}
          keyPlaceholder="Field"
        />
      )}

      {draft.body.type === 'graphql' && (
        <>
          <textarea
            value={draft.body.query ?? ''}
            onChange={(e) => updateDraft({ body: { ...draft.body, query: e.target.value } })}
            placeholder="query { me { id } }"
            className={`${input} h-40 w-full font-mono`}
          />
          <textarea
            value={draft.body.variables ?? ''}
            onChange={(e) => updateDraft({ body: { ...draft.body, variables: e.target.value } })}
            placeholder='{ "id": 1 }'
            className={`${input} h-20 w-full font-mono`}
          />
        </>
      )}

      {['json', 'text', 'xml'].includes(draft.body.type) && (
        <textarea
          value={draft.body.content ?? ''}
          onChange={(e) => updateDraft({ body: { ...draft.body, content: e.target.value } })}
          placeholder={draft.body.type === 'json' ? '{\n  "key": "value"\n}' : ''}
          className={`${input} h-64 w-full font-mono`}
          spellCheck={false}
        />
      )}
    </div>
  );
}

function AuthTab() {
  const { draft, updateDraft } = useStore();
  if (!draft) return null;
  const auth = draft.auth;

  const setType = (type: Auth['type']) => {
    const defaults: Record<Auth['type'], Auth> = {
      none: { type: 'none' },
      bearer: { type: 'bearer', token: '' },
      basic: { type: 'basic', username: '', password: '' },
      apiKey: { type: 'apiKey', in: 'header', key: '', value: '' },
      'oauth2-cc': {
        type: 'oauth2-cc',
        tokenUrl: '',
        clientId: '',
        clientSecret: '',
        clientAuth: 'header',
      },
    };
    updateDraft({ auth: defaults[type] });
  };

  return (
    <div className="flex max-w-xl flex-col gap-2">
      <select
        value={auth.type}
        onChange={(e) => setType(e.target.value as Auth['type'])}
        className={`${input} w-56`}
      >
        <option value="none">No auth</option>
        <option value="bearer">Bearer token</option>
        <option value="basic">Basic</option>
        <option value="apiKey">API key</option>
        <option value="oauth2-cc">OAuth2 client credentials</option>
      </select>

      <p className="text-xs text-slate-500">
        Reference a secret with <code className="text-slate-400">{'{{token}}'}</code> so it stays
        encrypted in the environment rather than saved on the request.
      </p>

      {auth.type === 'bearer' && (
        <Field
          label="Token"
          value={auth.token}
          onChange={(token) => updateDraft({ auth: { ...auth, token } })}
        />
      )}

      {auth.type === 'basic' && (
        <>
          <Field
            label="Username"
            value={auth.username}
            onChange={(username) => updateDraft({ auth: { ...auth, username } })}
          />
          <Field
            label="Password"
            value={auth.password}
            onChange={(password) => updateDraft({ auth: { ...auth, password } })}
          />
        </>
      )}

      {auth.type === 'apiKey' && (
        <>
          <select
            value={auth.in}
            onChange={(e) =>
              updateDraft({ auth: { ...auth, in: e.target.value as 'header' | 'query' } })
            }
            className={`${input} w-40`}
          >
            <option value="header">In header</option>
            <option value="query">In query string</option>
          </select>
          {auth.in === 'query' && (
            <p className="text-xs text-amber-400">
              A key in the query string ends up in server logs, proxies and browser history. A
              header is safer.
            </p>
          )}
          <Field
            label="Name"
            value={auth.key}
            onChange={(key) => updateDraft({ auth: { ...auth, key } })}
          />
          <Field
            label="Value"
            value={auth.value}
            onChange={(value) => updateDraft({ auth: { ...auth, value } })}
          />
        </>
      )}

      {auth.type === 'oauth2-cc' && (
        <>
          <Field
            label="Token URL"
            value={auth.tokenUrl}
            onChange={(tokenUrl) => updateDraft({ auth: { ...auth, tokenUrl } })}
          />
          <Field
            label="Client ID"
            value={auth.clientId}
            onChange={(clientId) => updateDraft({ auth: { ...auth, clientId } })}
          />
          <Field
            label="Client secret"
            value={auth.clientSecret}
            onChange={(clientSecret) => updateDraft({ auth: { ...auth, clientSecret } })}
          />
        </>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="w-28 shrink-0 text-slate-400">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${input} flex-1 font-mono`}
      />
    </label>
  );
}

function AssertionsTab() {
  const { draft, updateDraft } = useStore();
  if (!draft) return null;

  const rows = [
    ...draft.assertions,
    {
      type: 'status' as const,
      target: '',
      operator: 'equals' as const,
      expected: '',
      enabled: true,
    },
  ];

  const update = (index: number, patch: Partial<(typeof rows)[number]>) => {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    // Keep every row up to and including the one being edited. Filtering on "has a value"
    // discarded the trailing blank row the moment its type or operator changed, so the
    // dropdowns appeared frozen — they were resetting before anything could be typed.
    updateDraft({ assertions: next.slice(0, Math.max(draft.assertions.length, index + 1)) });
  };

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-slate-500">
        Checks run after every send; results appear under Checks in the response pane, and a failing
        check marks the run failed. For example: status equals 200, or response time less than 500.
      </p>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <select
            value={row.type}
            onChange={(e) => update(index, { type: e.target.value as typeof row.type })}
            className={`${input} w-36`}
          >
            <option value="status">Status</option>
            <option value="responseTime">Response time</option>
            <option value="header">Header</option>
            <option value="jsonPath">JSON path</option>
            <option value="bodyContains">Body contains</option>
          </select>

          {(row.type === 'header' || row.type === 'jsonPath') && (
            <input
              value={row.target}
              onChange={(e) => update(index, { target: e.target.value })}
              placeholder={row.type === 'header' ? 'content-type' : 'data.items[0].id'}
              className={`${input} w-48 font-mono`}
            />
          )}

          <select
            value={row.operator}
            onChange={(e) => update(index, { operator: e.target.value as typeof row.operator })}
            className={`${input} w-32`}
          >
            <option value="equals">equals</option>
            <option value="notEquals">not equals</option>
            <option value="contains">contains</option>
            <option value="lessThan">less than</option>
            <option value="greaterThan">greater than</option>
            <option value="exists">exists</option>
          </select>

          {row.operator === 'exists' ? (
            <span className="flex-1 text-xs text-slate-600">no value needed</span>
          ) : (
            <input
              value={row.expected}
              onChange={(e) => update(index, { expected: e.target.value })}
              placeholder={
                row.type === 'status'
                  ? '200'
                  : row.type === 'responseTime'
                    ? '500'
                    : row.type === 'header'
                      ? 'application/json'
                      : 'expected value'
              }
              className={`${input} flex-1 font-mono`}
            />
          )}

          <button
            type="button"
            onClick={() =>
              updateDraft({ assertions: draft.assertions.filter((_, i) => i !== index) })
            }
            disabled={index >= draft.assertions.length}
            className="px-1 text-slate-600 hover:text-rose-400 disabled:opacity-0"
            aria-label="Remove assertion"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
