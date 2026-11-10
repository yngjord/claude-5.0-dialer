import { listAll } from './airtable';
import { db, must } from './db';

const BUCKET = 'client-logos';
type Attachment = { id: string; url: string; type?: string; thumbnails?: { large?: { url: string } } };

/**
 * Copies each client's Airtable logo into the public `client-logos` bucket and records its fixed URL in
 * dialer_client_logos. Only new or changed logos (a different attachment id) are downloaded, so this is cheap to run
 * often. Clients whose logo was removed lose their row. Returns { airtable client id: url }.
 */
export async function syncClientLogos(): Promise<Record<string, string>> {
  const [records, rows] = await Promise.all([
    listAll<{ 'Client Logo Image': Attachment[] }>('Clients', { filterByFormula: "{Client Logo Image} != ''", fields: ['Client Logo Image'] }),
    db().from('dialer_client_logos').select('airtable_client_id, attachment_id, url').then(must),
  ]);
  const have = new Map((rows as { airtable_client_id: string; attachment_id: string; url: string }[]).map((r) => [r.airtable_client_id, r]));
  const logos: Record<string, string> = {};

  for (const r of records) {
    const file = r.fields['Client Logo Image']?.[0];
    if (!file) continue;
    const existing = have.get(r.id);
    if (existing?.attachment_id === file.id) {
      logos[r.id] = existing.url;
      continue;
    }
    try {
      // The "large" thumbnail is plenty for a 40px circle and much smaller than the original upload.
      const res = await fetch(file.thumbnails?.large?.url ?? file.url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const type = res.headers.get('content-type') ?? file.type ?? 'image/png';
      const ext = type.includes('jpeg') ? 'jpg' : type.includes('svg') ? 'svg' : type.includes('webp') ? 'webp' : 'png';
      const path = `${r.id}/${file.id}.${ext}`; // a new attachment gets a new path, so year-long caching is safe
      const { error } = await db().storage.from(BUCKET).upload(path, await res.arrayBuffer(), { contentType: type, upsert: true, cacheControl: '31536000' });
      if (error) throw new Error(error.message);
      const url = db().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      must(await db().from('dialer_client_logos').upsert({ airtable_client_id: r.id, attachment_id: file.id, url, updated_at: new Date().toISOString() }));
      logos[r.id] = url;
    } catch (err) {
      console.error('Client logo copy failed', r.id, err);
      if (existing) logos[r.id] = existing.url;
    }
  }

  const gone = [...have.keys()].filter((id) => !records.some((r) => r.id === id && r.fields['Client Logo Image']?.length));
  if (gone.length) must(await db().from('dialer_client_logos').delete().in('airtable_client_id', gone));
  return logos;
}
