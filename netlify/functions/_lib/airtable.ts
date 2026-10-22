import { env, HttpError } from './http';

export interface AirtableRecord<F> {
  id: string;
  createdTime: string;
  fields: Partial<F>;
}

const API = 'https://api.airtable.com/v0';

async function request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
  const res = await fetch(`${API}/${env('AIRTABLE_BASE_ID')}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env('AIRTABLE_API_KEY')}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  // Airtable allows 5 requests/sec per base; back off briefly and retry.
  if (res.status === 429 && attempt < 3) {
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return request<T>(path, init, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Airtable ${init.method ?? 'GET'} ${path} -> ${res.status}: ${body}`);
    let message = 'Could not reach Airtable. Please try again.';
    try {
      message = `Airtable: ${(JSON.parse(body) as { error?: { message?: string } }).error?.message ?? res.statusText}`;
    } catch {
      // keep the generic message
    }
    throw new HttpError(502, message);
  }
  return res.json() as Promise<T>;
}

/** Lists every record matching the formula, following Airtable's 100-record pages. */
export async function listAll<F>(
  table: string,
  opts: { filterByFormula: string; fields?: readonly (keyof F & string)[] },
): Promise<AirtableRecord<F>[]> {
  const records: AirtableRecord<F>[] = [];
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ filterByFormula: opts.filterByFormula, pageSize: '100' });
    opts.fields?.forEach((f) => params.append('fields[]', f));
    if (offset) params.set('offset', offset);
    const page = await request<{ records: AirtableRecord<F>[]; offset?: string }>(`${encodeURIComponent(table)}?${params}`);
    records.push(...page.records);
    offset = page.offset;
  } while (offset);
  return records;
}

/** Creates one record and returns its id. */
export async function createRecord<F>(table: string, fields: Partial<F>): Promise<string> {
  const res = await request<{ records: { id: string }[] }>(encodeURIComponent(table), {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: false }),
  });
  return res.records[0].id;
}
