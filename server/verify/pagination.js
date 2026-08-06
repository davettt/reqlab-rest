/**
 * Pagination: does walking every page actually give you every record, once?
 *
 * This is the suite that most often surprises people, because a paginated list looks correct
 * from the first page and nobody clicks through to the boundary. Off-by-one arithmetic on the
 * offset is easy to write and invisible until someone reconciles a total — at which point a
 * record has been counted twice in a report, or dropped from an export entirely.
 *
 * The suite walks the pages itself and compares what came back against what the endpoint says
 * it holds. Only GET requests are touched, and only ones whose response actually looks
 * paginated, so pointing this at a project full of ordinary endpoints does nothing rather than
 * inventing findings.
 */
import { finding, evidenceFrom } from './findings.js';

const SUITE = 'pagination';

/**
 * A walk is bounded twice over: by pages and by the endpoint's own total. Without a cap, a
 * cursor that never terminates turns a verification run into an unintentional load test
 * against someone else's API.
 */
const MAX_PAGES = 12;

/** Small enough that a walk is quick, large enough that a boundary bug has room to appear. */
const PAGE_SIZE = 5;

/** Keys under which APIs conventionally put the page of records. */
const ARRAY_KEYS = ['data', 'items', 'results', 'records', 'rows', 'list', 'content', 'entries'];

const TOTAL_KEYS = ['total', 'totalCount', 'total_count', 'totalItems', 'total_items', 'count'];

const CURSOR_KEYS = [
  'next',
  'nextCursor',
  'next_cursor',
  'nextPageToken',
  'next_page_token',
  'nextToken',
  'next_token',
  'after',
];

/**
 * @param {object} args
 * @param {Function} args.send      async (request) => sanitised run record
 * @param {object[]} args.requests  the requests to probe
 */
export async function runPagination({ send, requests }) {
  const findings = [];
  let probed = 0;

  for (const request of requests) {
    if ((request.method ?? 'GET').toUpperCase() !== 'GET') continue;

    const first = await safeSend(send, withPaging(request, { page: 1, limit: PAGE_SIZE }));
    if (!first || first.response.status >= 400) continue;

    const shape = shapeOf(first.response.body);
    if (!shape) continue;

    probed += 1;
    await walk({ findings, send, request, shape, first });
  }

  if (probed === 0) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'info',
        endpoint: null,
        title: 'No paginated endpoints were found',
        whatHappened:
          'None of the requests returned a response that looks like a page of records, so ' +
          'there was nothing to walk.',
        whyItMatters:
          'This is not a pass. If the API does paginate, add a request that lists records so ' +
          'the page boundaries can be checked.',
        expected: 'at least one list endpoint',
        actual: 'none',
      }),
    );
  }

  return findings;
}

/* ---------------------------------------------------------------- *
 * The walk
 * ---------------------------------------------------------------- */

async function walk({ findings, send, request, shape, first }) {
  const endpoint = label(request);
  const seen = new Map(); // record identity -> page it first appeared on
  const duplicates = [];
  const totals = new Set();

  let run = first;
  let page = 1;
  let cursor = null;
  let lastPageReached = false;

  while (page <= MAX_PAGES) {
    const body = parse(run.response.body);
    const records = recordsIn(body, shape);
    const total = totalIn(body);

    if (total !== null) totals.add(total);

    // Limit enforcement. An endpoint that ignores the caller's page size is not just untidy:
    // it is the difference between a 5-record response and the entire table.
    if (records.length > PAGE_SIZE) {
      findings.push(
        finding({
          suite: SUITE,
          severity: 'major',
          endpoint,
          title: `${endpoint} ignored the requested page size`,
          whatHappened:
            `The request asked for ${PAGE_SIZE} records per page and page ${page} returned ` +
            `${records.length}.`,
          whyItMatters:
            'A caller cannot control how much data comes back. On a large table that is a slow ' +
            'response at best and an out-of-memory client at worst.',
          expected: `at most ${PAGE_SIZE} records`,
          actual: `${records.length} records`,
          evidence: evidenceFrom(run),
        }),
      );
      break; // the rest of the walk would measure an endpoint that is not paging at all
    }

    for (const record of records) {
      const identity = identify(record);
      if (seen.has(identity)) {
        duplicates.push({ identity, firstPage: seen.get(identity), againOn: page, run });
      } else {
        seen.set(identity, page);
      }
    }

    if (records.length === 0) {
      lastPageReached = true;
      break;
    }

    cursor = shape.style === 'cursor' ? cursorIn(body) : null;
    if (shape.style === 'cursor' && !cursor) {
      lastPageReached = true;
      break;
    }

    if (total !== null && seen.size >= total) {
      lastPageReached = true;
      break;
    }

    page += 1;
    const next = await safeSend(send, nextRequest(request, shape, { page, cursor }));
    if (!next || next.response.status >= 400) {
      reportPageError({ findings, endpoint, page, run: next });
      break;
    }
    run = next;
  }

  reportDuplicates({ findings, endpoint, duplicates });
  reportTotals({ findings, endpoint, totals, run });
  reportCoverage({ findings, endpoint, seen, totals, lastPageReached, run });

  if (shape.style === 'cursor' && !lastPageReached) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint,
        title: `${endpoint} never signalled the end of the list`,
        whatHappened:
          `The cursor kept pointing at another page for all ${MAX_PAGES} pages that were ` +
          'walked, and the walk was stopped by its own safety limit.',
        whyItMatters:
          'A client that pages until the cursor runs out will loop forever, or until it is ' +
          'rate-limited. The last page must return no cursor.',
        expected: 'an empty cursor on the last page',
        actual: `still paging after ${MAX_PAGES} pages`,
        evidence: evidenceFrom(run),
      }),
    );
  }

  if (shape.style !== 'cursor') {
    await checkOutOfRange({ findings, send, request, shape, endpoint });
  }
}

/* ---------------------------------------------------------------- *
 * The individual judgements
 * ---------------------------------------------------------------- */

function reportDuplicates({ findings, endpoint, duplicates }) {
  if (!duplicates.length) return;

  const first = duplicates[0];
  const names = duplicates
    .slice(0, 5)
    .map((d) => d.identity)
    .join(', ');

  findings.push(
    finding({
      suite: SUITE,
      severity: 'major',
      endpoint,
      title: `${endpoint} returns the same record on more than one page`,
      whatHappened:
        `${duplicates.length} record${duplicates.length === 1 ? '' : 's'} appeared on two ` +
        `different pages. The first was ${first.identity}, on page ${first.firstPage} and ` +
        `again on page ${first.againOn}.`,
      whyItMatters:
        'Anyone paging through the whole list receives that record twice. Totals computed by ' +
        'the caller will be wrong, exports will contain duplicates, and a record is almost ' +
        'certainly being skipped elsewhere to make room for it — the usual cause is an ' +
        'off-by-one in the page offset.',
      expected: 'each record on exactly one page',
      actual: `duplicated: ${names}${duplicates.length > 5 ? ', …' : ''}`,
      evidence: evidenceFrom(first.run),
    }),
  );
}

function reportTotals({ findings, endpoint, totals, run }) {
  if (totals.size <= 1) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'minor',
      endpoint,
      title: `${endpoint} reported a different total on different pages`,
      whatHappened: `The total changed while paging: ${[...totals].join(', ')}.`,
      whyItMatters:
        'A caller uses the total to size progress bars and to decide how many pages to fetch. ' +
        'If it moves mid-walk, either records are changing underneath the query or the count ' +
        'and the page come from different sources.',
      expected: 'the same total on every page',
      actual: [...totals].join(', '),
      evidence: evidenceFrom(run),
    }),
  );
}

function reportCoverage({ findings, endpoint, seen, totals, lastPageReached, run }) {
  if (!lastPageReached || totals.size !== 1) return;

  const [total] = [...totals];
  if (seen.size >= total) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: 'blocker',
      endpoint,
      title: `${endpoint} does not return every record when you walk the pages`,
      whatHappened:
        `The endpoint reports ${total} records, but walking every page produced ` +
        `${seen.size} distinct ones.`,
      whyItMatters:
        `${total - seen.size} record${total - seen.size === 1 ? ' is' : 's are'} unreachable ` +
        'through the API. Anything built on this list — an export, a sync, a reconciliation — ' +
        'silently misses them, and nothing in the response indicates that.',
      expected: `${total} distinct records`,
      actual: `${seen.size}`,
      evidence: evidenceFrom(run),
    }),
  );
}

function reportPageError({ findings, endpoint, page, run }) {
  if (!run) return;

  findings.push(
    finding({
      suite: SUITE,
      severity: run.response.status >= 500 ? 'blocker' : 'major',
      endpoint,
      title: `${endpoint} failed part-way through the list`,
      whatHappened: `Page ${page} returned ${run.response.status}, while page 1 succeeded.`,
      whyItMatters:
        'A caller cannot read the whole list. Where the failure is a 5xx, the pagination ' +
        'arithmetic is probably producing an invalid query at the boundary.',
      expected: 'the same status as page 1',
      actual: String(run.response.status),
      evidence: evidenceFrom(run),
    }),
  );
}

/**
 * Ask for a page far past the end.
 *
 * The correct answer is an empty page. The two wrong answers both cause real bugs: an error
 * makes a client that pages one step too far look broken, and silently returning the last page
 * (or the first) makes a "page until empty" loop run forever.
 */
async function checkOutOfRange({ findings, send, request, shape, endpoint }) {
  const run = await safeSend(send, nextRequest(request, shape, { page: 9999 }));
  if (!run) return;

  if (run.response.status >= 400) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'minor',
        endpoint,
        title: `${endpoint} errors when asked for a page past the end`,
        whatHappened: `Requesting a page beyond the last one returned ${run.response.status}.`,
        whyItMatters:
          'Clients commonly page until they get an empty response. An error there is ' +
          'indistinguishable from a real failure, so the client either stops early or retries.',
        expected: '200 with an empty list',
        actual: String(run.response.status),
        evidence: evidenceFrom(run),
      }),
    );
    return;
  }

  const records = recordsIn(parse(run.response.body), shape);
  if (records.length > 0) {
    findings.push(
      finding({
        suite: SUITE,
        severity: 'major',
        endpoint,
        title: `${endpoint} returns records for a page that does not exist`,
        whatHappened:
          `Requesting a page far beyond the end still returned ${records.length} record` +
          `${records.length === 1 ? '' : 's'}.`,
        whyItMatters:
          'The page number is being ignored or clamped. A client that pages until the response ' +
          'is empty will never stop, and any deep link to a page shows the wrong records.',
        expected: 'an empty list',
        actual: `${records.length} records`,
        evidence: evidenceFrom(run),
      }),
    );
  }
}

/* ---------------------------------------------------------------- *
 * Shape detection
 * ---------------------------------------------------------------- */

/**
 * Decide whether a response is a page of records, and how it is paged.
 *
 * Deliberately conservative. Guessing wrong means walking an endpoint that does not paginate
 * and reporting nonsense about it, which costs more credibility than the missed check.
 */
function shapeOf(rawBody) {
  const body = parse(rawBody);
  if (body === null) return null;

  // A bare top-level array carries no paging metadata, so there is nothing to check and no way
  // to tell it apart from a complete, unpaginated list. Left alone deliberately.
  if (Array.isArray(body)) return null;

  const arrayKey = ARRAY_KEYS.find((k) => Array.isArray(body[k]));
  if (arrayKey === undefined) return null;

  const hasTotal = TOTAL_KEYS.some((k) => typeof body[k] === 'number');
  const hasCursor = CURSOR_KEYS.some((k) => truthyCursor(body[k]));
  const hasPage = typeof body.page === 'number';
  const hasOffset = typeof body.offset === 'number';

  if (hasCursor) return { style: 'cursor', arrayKey };
  if (hasOffset) return { style: 'offset', arrayKey };
  if (hasPage || hasTotal) return { style: 'page', arrayKey };

  return null;
}

function recordsIn(body, shape) {
  if (body === null) return [];
  const array = body[shape.arrayKey];
  return Array.isArray(array) ? array : [];
}

function totalIn(body) {
  if (body === null || Array.isArray(body)) return null;
  for (const key of TOTAL_KEYS) {
    if (typeof body[key] === 'number') return body[key];
  }
  return null;
}

function cursorIn(body) {
  if (body === null || Array.isArray(body)) return null;
  for (const key of CURSOR_KEYS) {
    if (truthyCursor(body[key])) return String(body[key]);
  }
  // Some APIs nest it, e.g. { links: { next: "..." } }.
  for (const nest of ['links', 'meta', 'paging', 'pagination', 'page_info']) {
    const inner = body[nest];
    if (inner && typeof inner === 'object') {
      for (const key of CURSOR_KEYS) {
        if (truthyCursor(inner[key])) return String(inner[key]);
      }
    }
  }
  return null;
}

function truthyCursor(value) {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'number';
}

/**
 * Identify a record so the same one can be recognised on a later page.
 *
 * An id field is used when there is one. Otherwise the whole record is compared, which is
 * stricter than it looks: two genuinely distinct records with identical contents would be
 * reported as a duplicate. That is the safer direction to err in — a list that returns two
 * indistinguishable rows is a problem for the caller either way.
 */
function identify(record) {
  if (record === null || typeof record !== 'object') return JSON.stringify(record);

  for (const key of ['id', 'uuid', 'guid', '_id', 'key', 'slug']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') return `${key}=${value}`;
  }
  return stableStringify(record);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/* ---------------------------------------------------------------- *
 * Request construction
 * ---------------------------------------------------------------- */

function withPaging(request, { page, limit }) {
  return {
    ...request,
    params: [
      ...(request.params ?? []).filter((p) => !isPagingParam(p.key)),
      { key: 'page', value: String(page), enabled: true },
      { key: 'limit', value: String(limit), enabled: true },
    ],
  };
}

function nextRequest(request, shape, { page, cursor }) {
  const base = (request.params ?? []).filter((p) => !isPagingParam(p.key));

  if (shape.style === 'cursor' && cursor) {
    return {
      ...request,
      params: [
        ...base,
        { key: 'limit', value: String(PAGE_SIZE), enabled: true },
        { key: 'cursor', value: cursor, enabled: true },
      ],
    };
  }

  if (shape.style === 'offset') {
    return {
      ...request,
      params: [
        ...base,
        { key: 'limit', value: String(PAGE_SIZE), enabled: true },
        { key: 'offset', value: String((page - 1) * PAGE_SIZE), enabled: true },
      ],
    };
  }

  return withPaging(request, { page, limit: PAGE_SIZE });
}

const PAGING_PARAMS = new Set([
  'page',
  'limit',
  'offset',
  'cursor',
  'per_page',
  'perPage',
  'page_size',
  'pageSize',
  'after',
]);

function isPagingParam(key) {
  return PAGING_PARAMS.has(String(key ?? ''));
}

/* ---------------------------------------------------------------- *
 * Shared helpers
 * ---------------------------------------------------------------- */

async function safeSend(send, request) {
  try {
    return await send(request);
  } catch {
    return null;
  }
}

function parse(body) {
  try {
    const value = JSON.parse(String(body ?? ''));
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function label(request) {
  const path = String(request.url ?? '')
    .replace(/^\{\{baseUrl\}\}/, '')
    .replace(/\?.*$/, '');
  return `${request.method} ${path}`;
}
