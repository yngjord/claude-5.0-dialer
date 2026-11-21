import { HttpError } from './http';

const QUERY_URL = 'https://api.clay.com/public/v0/tables/query';

export const clayConfigured = () => !!process.env.CLAY_API_KEY?.trim();

type Cell = { status?: string; value?: unknown };
type QueryResponse = { data: Record<string, Cell>[]; cursor?: string; fields?: Record<string, { id: string; name: string; type: string }> };

/** One page of Clay's structured table query. Turns Clay's refusals into messages an admin can act on. */
async function query(body: unknown): Promise<QueryResponse> {
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'clay-api-key': process.env.CLAY_API_KEY!.trim() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as QueryResponse & { message?: string };
  if (res.ok) return data;
  const msg = data.message ?? '';
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Clay refused the API key. Check CLAY_API_KEY in Netlify is a Public API key.');
  if (res.status === 404) throw new HttpError(400, 'Clay can’t find that table. Check the URL is from this Clay workspace.');
  if (/sync/i.test(msg)) throw new HttpError(400, 'API reading isn’t switched on for this table yet. Turn on its sync (ClayQL) in Clay, then check again.');
  if (res.status === 429) throw new HttpError(429, 'Clay is rate-limiting us. Try again in a minute.');
  throw new HttpError(502, `Clay couldn’t read the table${msg ? `: ${msg}` : ''}.`);
}

/** The table's column names (from one row's query). */
export async function clayColumns(tableId: string): Promise<string[]> {
  const page = await query({ query: { tables: [{ id: tableId }] }, limit: 1 });
  return Object.values(page.fields ?? {}).map((f) => f.name);
}

/**
 * Reads the chosen columns of every row, 100 at a time, until the table ends or the time budget runs out (a request
 * must finish within Netlify's 60 seconds; about 10,000 rows fit).
 */
export async function clayRows(tableId: string, columns: Record<string, string>, budgetMs = 40_000) {
  const select = Object.entries(columns).map(([as, field]) => ({ field, as }));
  const until = Date.now() + budgetMs;
  const rows: Record<string, string | null>[] = [];
  let cursor: string | undefined;
  do {
    const page = await query({ query: { tables: [{ id: tableId }], field_mode: 'names', select }, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const r of page.data ?? []) {
      rows.push(Object.fromEntries(Object.keys(columns).map((k) => [k, typeof r[k]?.value === 'string' ? (r[k].value as string) : null])));
    }
    cursor = page.data?.length ? page.cursor : undefined;
  } while (cursor && Date.now() < until);
  return { rows, complete: !cursor };
}
