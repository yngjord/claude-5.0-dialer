import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

// Runs the real migration on an in-memory Postgres with the bits of Supabase it relies on stubbed
// (auth.users / auth.uid(), storage, the realtime publication, the portal's profiles table).

const SUPABASE_STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create publication supabase_realtime;
  grant usage on schema public, auth, storage to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  create type public.user_role as enum ('client', 'team', 'admin');
  create table public.profiles (id uuid primary key references auth.users(id), role public.user_role not null default 'client', email text, client_names text[] not null default '{}');
  alter table public.profiles enable row level security;
  create policy "Users can view own profile" on public.profiles for select to authenticated using (auth.uid() = id);
`;

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const TEAM1 = '00000000-0000-0000-0000-000000000001';
const TEAM2 = '00000000-0000-0000-0000-000000000002';
const CLIENT = '00000000-0000-0000-0000-00000000000c';
const CAMPAIGN = '10000000-0000-0000-0000-000000000001';
const OTHER_CAMPAIGN = '10000000-0000-0000-0000-000000000002';

let pg: PGlite;

async function as<T>(userId: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec(userId ? `set role authenticated; set request.jwt.claim.sub = '${userId}';` : 'reset role;');
  try {
    return await fn();
  } finally {
    await pg.exec(`reset role; set request.jwt.claim.sub = '';`);
  }
}

const rows = async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows;

/** As the Netlify functions: the service role. */
async function asServer<T>(fn: () => Promise<T>): Promise<T> {
  await pg.exec(`set role service_role; set request.jwt.claim.role = 'service_role';`);
  try {
    return await fn();
  } finally {
    await pg.exec(`reset role; set request.jwt.claim.role = '';`);
  }
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(SUPABASE_STUBS);
  const migration = readFileSync(new URL('./migrations/20261022000000_dialer.sql', import.meta.url), 'utf8');
  await pg.exec(migration);
  // Re-running must be safe.
  await pg.exec(migration);

  await pg.exec(`
    insert into auth.users (id, email) values ('${ADMIN}', 'admin@x'), ('${TEAM1}', 't1@x'), ('${TEAM2}', 't2@x'), ('${CLIENT}', 'c@x');
    insert into profiles (id, role, email) values ('${ADMIN}', 'admin', 'admin@x'), ('${TEAM1}', 'team', 't1@x'), ('${TEAM2}', 'team', 't2@x'), ('${CLIENT}', 'client', 'c@x');
    insert into dialer_campaigns (id, name, client_name, airtable_client_id) values
      ('${CAMPAIGN}', 'Kintell Oct', 'Kintell', 'recKintell'),
      ('${OTHER_CAMPAIGN}', 'Other', 'Morfless', 'recMorfless');
    -- Two team members on one campaign, as campaigns assigned before the one-team-member rule can still have.
    alter table dialer_campaign_members disable trigger dialer_campaign_members_one_team;
    insert into dialer_campaign_members (campaign_id, user_id) values ('${CAMPAIGN}', '${TEAM1}'), ('${CAMPAIGN}', '${TEAM2}');
    alter table dialer_campaign_members enable trigger dialer_campaign_members_one_team;
    insert into dialer_contacts (campaign_id, full_name, phone_e164, created_at) values
      ('${CAMPAIGN}', 'A', '+61411111111', now() - interval '3 hours'),
      ('${CAMPAIGN}', 'B', '+61422222222', now() - interval '2 hours'),
      ('${CAMPAIGN}', 'C', '+61433333333', now() - interval '1 hour');
    insert into dialer_contacts (campaign_id, full_name, phone_e164, status) values ('${CAMPAIGN}', 'Done', '+61444444444', 'done');
    insert into dialer_contacts (campaign_id, full_name, phone_e164, status, next_attempt_at) values ('${CAMPAIGN}', 'Later', '+61466666666', 'callback', now() + interval '1 day');
    insert into dialer_contacts (campaign_id, full_name, phone_e164) values ('${OTHER_CAMPAIGN}', 'Elsewhere', '+64211234567');
  `);
});

describe('pickup status trigger', () => {
  const newCall = async () => (await rows<{ id: string }>(`insert into dialer_calls (twilio_status) values ('initiated') returning id`))[0].id;
  const pickup = async (id: string) => (await rows<{ pickup_status: string | null }>('select pickup_status from dialer_calls where id = $1', [id]))[0].pickup_status;

  it('stays empty while ringing', async () => {
    const id = await newCall();
    await pg.query(`update dialer_calls set twilio_status = 'ringing' where id = $1`, [id]);
    expect(await pickup(id)).toBeNull();
  });

  it('uses AMD whichever callback arrives first', async () => {
    const a = await newCall();
    await pg.query(`update dialer_calls set twilio_status = 'in-progress', answered_at = now() where id = $1`, [a]);
    await pg.query(`update dialer_calls set answered_by = 'human' where id = $1`, [a]);
    await pg.query(`update dialer_calls set twilio_status = 'completed' where id = $1`, [a]);
    expect(await pickup(a)).toBe('Human Pickup');

    const b = await newCall();
    await pg.query(`update dialer_calls set twilio_status = 'completed', answered_at = now() where id = $1`, [b]);
    expect(await pickup(b)).toBe('Unclassified Pickup');
    await pg.query(`update dialer_calls set answered_by = 'machine_end_beep' where id = $1`, [b]);
    expect(await pickup(b)).toBe('Machine Pickup');
  });

  it('maps unanswered outcomes', async () => {
    for (const [status, expected] of [['no-answer', 'Unanswered'], ['canceled', 'Unanswered'], ['busy', 'Busy'], ['failed', 'Failed']]) {
      const id = await newCall();
      await pg.query(`update dialer_calls set twilio_status = $2 where id = $1`, [id, status]);
      expect(await pickup(id)).toBe(expected);
    }
  });

  it("never overrides the rep's correction", async () => {
    const id = await newCall();
    await pg.query(`update dialer_calls set pickup_status = 'Human Pickup', pickup_source = 'agent' where id = $1`, [id]);
    await pg.query(`update dialer_calls set answered_by = 'machine_start', twilio_status = 'completed' where id = $1`, [id]);
    expect(await pickup(id)).toBe('Human Pickup');
  });

  it('leaves imported JustCall rows alone', async () => {
    const [{ pickup_status }] = await rows<{ pickup_status: string }>(
      `insert into dialer_calls (source, pickup_source, pickup_status, twilio_status) values ('justcall', 'import', 'Machine Pickup', 'completed') returning pickup_status`,
    );
    expect(pickup_status).toBe('Machine Pickup');
  });
});

describe('claim_next_contact', () => {
  const claim = (user: string, campaign = CAMPAIGN) =>
    as(user, () => rows<{ full_name: string; locked_by: string }>('select full_name, locked_by from dialer_claim_next_contact($1)', [campaign]));

  it('gives two reps different contacts, oldest first, skipping finished and not-yet-due ones', async () => {
    const [first] = await claim(TEAM1);
    const [second] = await claim(TEAM2);
    expect(first).toMatchObject({ full_name: 'A', locked_by: TEAM1 });
    expect(second).toMatchObject({ full_name: 'B', locked_by: TEAM2 });

    // Claiming again first lets go of what you held, so rep 1 gets A back rather than piling up locks.
    const [third] = await claim(TEAM1);
    expect(third.full_name).toBe('A');
    const remaining = await claim(TEAM2);
    expect(remaining.map((r) => r.full_name)).not.toContain('Done');
    expect(remaining.map((r) => r.full_name)).not.toContain('Later');
  });

  it('skips numbers marked Do Not Call in any campaign', async () => {
    await pg.exec(`insert into dialer_contacts (campaign_id, full_name, phone_e164, status) values ('${OTHER_CAMPAIGN}', 'DNC elsewhere', '+61411111111', 'do_not_call')`);
    const names = [...(await claim(TEAM1)), ...(await claim(TEAM2))].map((r) => r.full_name);
    expect(names).not.toContain('A');
    await pg.exec(`delete from dialer_contacts where full_name = 'DNC elsewhere'`);
  });

  it('returns nothing when the queue is empty', async () => {
    await as(null, () => pg.exec(`update dialer_contacts set locked_by = '${ADMIN}', locked_at = now() where campaign_id = '${CAMPAIGN}'`));
    expect(await claim(TEAM1)).toEqual([]);
    await as(null, () => pg.exec(`update dialer_contacts set locked_by = null, locked_at = null`));
  });

  it('takes over abandoned locks', async () => {
    await as(null, () => pg.exec(`update dialer_contacts set locked_by = '${TEAM2}', locked_at = now() - interval '31 minutes' where campaign_id = '${CAMPAIGN}'`));
    const [c] = await claim(TEAM1);
    expect(c.locked_by).toBe(TEAM1);
    await as(null, () => pg.exec(`update dialer_contacts set locked_by = null, locked_at = null`));
  });

  it('refuses reps who are not on the campaign, and paused campaigns', async () => {
    await expect(claim(TEAM1, OTHER_CAMPAIGN)).rejects.toThrow(/not assigned/);
    await expect(claim(CLIENT)).rejects.toThrow(/not assigned/);
    await as(null, () => pg.exec(`update dialer_campaigns set status = 'paused' where id = '${CAMPAIGN}'`));
    await expect(claim(TEAM1)).rejects.toThrow(/paused/);
    await as(null, () => pg.exec(`update dialer_campaigns set status = 'active' where id = '${CAMPAIGN}'`));
  });

  it('release with skip moves the contact to the back of the queue', async () => {
    const [c] = await as(TEAM1, () => rows<{ id: string }>('select id from dialer_claim_next_contact($1)', [CAMPAIGN]));
    await as(TEAM1, () => pg.query('select dialer_release_contact($1, true)', [c.id]));
    const [after] = await rows<{ locked_by: string | null }>('select locked_by from dialer_contacts where id = $1', [c.id]);
    expect(after.locked_by).toBeNull();
    const [next] = await as(TEAM1, () => rows<{ id: string }>('select id from dialer_claim_next_contact($1)', [CAMPAIGN]));
    expect(next.id).not.toBe(c.id);
    await as(null, () => pg.exec(`update dialer_contacts set locked_by = null, locked_at = null, next_attempt_at = null`));
  });
});

describe('server call steps', () => {
  const CALL = '20000000-0000-0000-0000-000000000001';
  const contactId = async (name: string) => (await rows<{ id: string }>('select id from dialer_contacts where full_name = $1', [name]))[0].id;
  const start = (callId: string, contact: string, user: string) =>
    asServer(async () => (await rows<{ r: Record<string, string> }>('select dialer_start_call($1, $2, $3, $4) as r', [callId, contact, user, `CA-${callId}`]))[0].r);
  const wrapUp = (callId: string, user: string, disposition: string, status: string, pickup = 'Human Pickup') =>
    asServer(async () => (await rows<{ r: Record<string, string> }>('select dialer_wrap_up($1, $2, $3, $4, $5, $6) as r', [callId, user, pickup, disposition, ' notes ', status]))[0].r);

  it('only the server can call them', async () => {
    await expect(as(TEAM1, () => pg.query('select dialer_start_call($1, $2, $3, $4)', [CALL, CALL, TEAM1, 'CA1']))).rejects.toThrow(/permission denied/);
    await expect(as(TEAM1, () => pg.query('select dialer_wrap_up($1, $2, $3, $4, $5, $6)', [CALL, TEAM1, 'x', 'x', 'x', 'done']))).rejects.toThrow(/permission denied/);
  });

  it('starts a call: checks the rep, picks the caller number and logs the call', async () => {
    await pg.exec(`insert into dialer_phone_numbers (e164, client_name) values ('+61400000099', 'Kintell'), ('+61400000098', null)`);
    await pg.exec(`update dialer_phone_numbers set is_default = true where e164 = '+61400000098'`);
    const a = await contactId('A');
    expect(await start(CALL, a, TEAM1)).toEqual({ from: '+61400000099', to: '+61411111111' });
    const [call] = await rows<Record<string, unknown>>('select user_id, agent_name, client_name, campaign_name, full_name, from_number, twilio_status, twilio_call_sid from dialer_calls where id = $1', [CALL]);
    expect(call).toEqual({ user_id: TEAM1, agent_name: 't1@x', client_name: 'Kintell', campaign_name: 'Kintell Oct', full_name: 'A', from_number: '+61400000099', twilio_status: 'initiated', twilio_call_sid: `CA-${CALL}` });

    expect(await start('20000000-0000-0000-0000-000000000002', await contactId('Elsewhere'), TEAM1)).toEqual({ error: 'member' });
    expect(await start('20000000-0000-0000-0000-000000000003', a, CLIENT)).toEqual({ error: 'user' });
    expect(await start('20000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-0000000000ff', TEAM1)).toEqual({ error: 'contact' });
    // Admins can call any campaign; Morfless has no number of its own, so the default is used.
    expect(await start('20000000-0000-0000-0000-000000000005', await contactId('Elsewhere'), ADMIN)).toEqual({ from: '+61400000098', to: '+64211234567' });
  });

  it('saves a wrap-up once, moves the contact on, and only lets the rep (or an admin) do it', async () => {
    expect(await wrapUp(CALL, TEAM2, 'No Answer', 'done')).toEqual({ error: 'forbidden' });
    expect(await wrapUp(CALL, TEAM1, 'Not Interested', 'done', 'Machine Pickup')).toMatchObject({ campaign_name: 'Kintell Oct', airtable_client_id: 'recKintell' });
    await wrapUp(CALL, TEAM1, 'Not Interested', 'done', 'Machine Pickup');
    const [call] = await rows<Record<string, unknown>>('select disposition, notes, pickup_status, pickup_source, wrapped_up_at is not null as saved from dialer_calls where id = $1', [CALL]);
    expect(call).toEqual({ disposition: 'Not Interested', notes: 'notes', pickup_status: 'Machine Pickup', pickup_source: 'agent', saved: true });
    const [contact] = await rows<Record<string, unknown>>(`select status, attempts, last_disposition, locked_by from dialer_contacts where full_name = 'A'`);
    expect(contact).toEqual({ status: 'done', attempts: 1, last_disposition: 'Not Interested', locked_by: null });
    expect(await wrapUp('20000000-0000-0000-0000-0000000000ff', TEAM1, 'No Answer', 'done')).toEqual({ error: 'not_found' });
  });

  it('Do Not Call blocks the number in every campaign', async () => {
    await pg.exec(`insert into dialer_contacts (campaign_id, full_name, phone_e164) values ('${OTHER_CAMPAIGN}', 'A elsewhere', '+61411111111')`);
    await wrapUp(CALL, TEAM1, 'Do Not Call', 'do_not_call');
    expect(await rows(`select status from dialer_contacts where phone_e164 = '+61411111111'`)).toEqual([{ status: 'do_not_call' }, { status: 'do_not_call' }]);
  });

  it('fetching the next contact can keep the one being wrapped up', async () => {
    await pg.exec(`
      delete from dialer_contacts where full_name = 'A elsewhere';
      update dialer_contacts set status = 'new', attempts = 0, last_disposition = null, locked_by = null, locked_at = null, next_attempt_at = null where full_name in ('A', 'B', 'C');
    `);
    const claim = (keep: string | null) => as(TEAM1, () => rows<{ full_name: string }>('select full_name from dialer_claim_next($1, $2)', [CAMPAIGN, keep]));
    expect((await claim(null))[0].full_name).toBe('A');
    const a = await contactId('A');
    expect((await claim(a))[0].full_name).toBe('B');
    expect(await rows(`select full_name from dialer_contacts where locked_by = '${TEAM1}' order by full_name`)).toEqual([{ full_name: 'A' }, { full_name: 'B' }]);
    // Without keep, claiming lets go of everything held.
    expect((await claim(null))[0].full_name).toBe('A');
    expect(await rows(`select full_name from dialer_contacts where locked_by = '${TEAM1}'`)).toEqual([{ full_name: 'A' }]);

    await pg.exec(`
      update dialer_contacts set locked_by = null, locked_at = null;
      delete from dialer_calls where id::text like '20000000-%';
      delete from dialer_phone_numbers;
    `);
  });
});

describe('re-run by disposition', () => {
  it('admins copy chosen contacts into a new campaign, never Do Not Call numbers; team members cannot', async () => {
    await pg.exec(`
      insert into dialer_contacts (campaign_id, full_name, phone_e164, status, last_disposition, attempts, custom) values
        ('${CAMPAIGN}', 'NA1', '+61470000001', 'done', 'No Answer', 1, '{"industry":"SaaS"}'),
        ('${CAMPAIGN}', 'NA2', '+61470000002', 'done', 'No Answer', 1, '{}'),
        ('${CAMPAIGN}', 'NI', '+61470000003', 'done', 'Not Interested', 1, '{}'),
        ('${CAMPAIGN}', 'NA but DNC', '+61470000004', 'done', 'No Answer', 1, '{}'),
        ('${OTHER_CAMPAIGN}', 'DNC', '+61470000004', 'do_not_call', 'Do Not Call', 1, '{}');
    `);
    const counts = await as(ADMIN, () => rows<{ disposition: string; contacts: number }>('select * from dialer_rerun_counts($1)', [CAMPAIGN]));
    expect(counts).toContainEqual({ disposition: 'No Answer', contacts: 2 });
    expect(await as(TEAM1, () => rows('select * from dialer_rerun_counts($1)', [CAMPAIGN]))).toEqual([]);
    await expect(as(TEAM1, () => pg.query('select * from dialer_rerun_campaign($1, $2, $3, $4)', [CAMPAIGN, ['No Answer'], 'Again', 'active']))).rejects.toThrow(/Only admins/);

    const [made] = await as(ADMIN, () => rows<{ campaign_id: string; contacts: number }>('select * from dialer_rerun_campaign($1, $2, $3, $4)', [CAMPAIGN, ['No Answer'], ' Kintell re-run ', 'active']));
    expect(made.contacts).toBe(2);
    const [camp] = await rows<{ name: string; client_name: string; status: string }>('select name, client_name, status from dialer_campaigns where id = $1', [made.campaign_id]);
    expect(camp).toEqual({ name: 'Kintell re-run', client_name: 'Kintell', status: 'active' });
    const copied = await rows<{ full_name: string; status: string; attempts: number; custom: unknown }>('select full_name, status, attempts, custom from dialer_contacts where campaign_id = $1 order by full_name', [made.campaign_id]);
    expect(copied).toEqual([
      { full_name: 'NA1', status: 'new', attempts: 0, custom: { industry: 'SaaS' } },
      { full_name: 'NA2', status: 'new', attempts: 0, custom: {} },
    ]);
    // The original has two team members from before the one-team-member rule; the copy gets one.
    const members = await rows('select user_id from dialer_campaign_members where campaign_id = $1', [made.campaign_id]);
    expect(members).toEqual([{ user_id: TEAM1 }]);
    // The original campaign is untouched.
    const [orig] = await rows<{ status: string }>(`select status from dialer_contacts where campaign_id = '${CAMPAIGN}' and full_name = 'NA1'`);
    expect(orig.status).toBe('done');

    await pg.exec(`delete from dialer_campaigns where id = '${made.campaign_id}'`);

    // Saved as a draft: only admins see it.
    const [draft] = await as(ADMIN, () => rows<{ campaign_id: string }>('select * from dialer_rerun_campaign($1, $2, $3)', [CAMPAIGN, ['No Answer'], 'Draft re-run']));
    expect((await rows<{ status: string }>('select status from dialer_campaigns where id = $1', [draft.campaign_id]))[0].status).toBe('draft');
    expect(await as(TEAM1, () => rows('select id from dialer_campaigns where id = $1', [draft.campaign_id]))).toEqual([]);
    expect(await as(TEAM1, () => rows('select id from dialer_contacts where campaign_id = $1', [draft.campaign_id]))).toEqual([]);
    expect(await as(ADMIN, () => rows('select id from dialer_campaigns where id = $1', [draft.campaign_id]))).toHaveLength(1);
    await pg.exec(`delete from dialer_campaigns where id = '${draft.campaign_id}'`);
    await pg.exec(`delete from dialer_contacts where full_name in ('NA1', 'NA2', 'NI', 'NA but DNC', 'DNC')`);
  });
});

describe('row level security', () => {
  it('portal clients see nothing', async () => {
    await as(CLIENT, async () => {
      expect(await rows('select * from dialer_campaigns')).toEqual([]);
      expect(await rows('select * from dialer_contacts')).toEqual([]);
      expect(await rows('select * from dialer_calls')).toEqual([]);
      expect(await rows('select * from dialer_phone_numbers')).toEqual([]);
      expect(await rows('select * from dialer_users()')).toEqual([]);
    });
  });

  it('team members only see their campaigns', async () => {
    await as(TEAM1, async () => {
      expect((await rows<{ name: string }>('select name from dialer_campaigns')).map((r) => r.name)).toEqual(['Kintell Oct']);
      expect((await rows<{ full_name: string }>('select full_name from dialer_contacts')).map((r) => r.full_name)).not.toContain('Elsewhere');
      expect((await rows('select * from dialer_users()')).length).toBe(3);
    });
  });

  it("team members can't read clients' phone numbers; admins can", async () => {
    await pg.exec(`insert into dialer_phone_numbers (e164, client_name) values ('+61400000097', 'Kintell')`);
    expect(await as(TEAM1, () => rows('select * from dialer_phone_numbers'))).toEqual([]);
    expect(await as(ADMIN, () => rows('select * from dialer_phone_numbers'))).toHaveLength(1);
    await pg.exec(`delete from dialer_phone_numbers`);
  });

  it('reps only see calls they made, even in a shared campaign; admins see all', async () => {
    await pg.exec(`
      insert into dialer_calls (campaign_id, user_id, agent_name, twilio_status) values
        ('${CAMPAIGN}', '${TEAM1}', 'T1', 'completed'), ('${CAMPAIGN}', '${TEAM2}', 'T2', 'completed')`);
    const agents = async (user: string) => (await as(user, () => rows<{ agent_name: string }>(`select distinct agent_name from dialer_calls where agent_name in ('T1', 'T2') order by 1`))).map((r) => r.agent_name);
    expect(await agents(TEAM1)).toEqual(['T1']);
    expect(await agents(TEAM2)).toEqual(['T2']);
    expect(await agents(ADMIN)).toEqual(['T1', 'T2']);
    await pg.exec(`delete from dialer_calls where agent_name in ('T1', 'T2')`);
  });

  it('admins see everything', async () => {
    await as(ADMIN, async () => {
      expect((await rows('select * from dialer_campaigns')).length).toBe(2);
    });
  });

  it("team members can import into their campaigns but can't edit contacts or calls", async () => {
    await as(TEAM1, async () => {
      await pg.query(`insert into dialer_contacts (campaign_id, phone_e164) values ($1, '+61477777777')`, [CAMPAIGN]);
      await expect(pg.query(`insert into dialer_contacts (campaign_id, phone_e164) values ($1, '+61477777778')`, [OTHER_CAMPAIGN])).rejects.toThrow();
      const updated = await pg.query(`update dialer_contacts set status = 'done' where campaign_id = $1`, [CAMPAIGN]);
      expect(updated.affectedRows).toBe(0);
      await expect(pg.query(`update dialer_calls set disposition = 'Do Not Call'`)).rejects.toThrow(/permission denied/);
      await expect(pg.query(`insert into dialer_calls (direction) values ('outbound')`)).rejects.toThrow(/permission denied/);
    });
  });

  it('signed-out visitors cannot call the queue functions', async () => {
    await pg.exec('set role anon');
    try {
      await expect(pg.query('select * from dialer_claim_next_contact($1)', [CAMPAIGN])).rejects.toThrow(/permission denied/);
      await expect(pg.query('select * from dialer_users()')).rejects.toThrow(/permission denied/);
      await expect(pg.query('select * from dialer_rerun_campaign($1, $2, $3, $4)', [CAMPAIGN, ['No Answer'], 'x', 'draft'])).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec('reset role');
    }
  });

  it('only AU/NZ mobiles can be stored', async () => {
    await expect(pg.query(`insert into dialer_contacts (campaign_id, phone_e164) values ($1, '+61298765432')`, [CAMPAIGN])).rejects.toThrow(/check/);
  });
});

describe('deleting a campaign', () => {
  it('only admins can; contacts and members go, calls stay with their snapshot', async () => {
    const DOOMED = '10000000-0000-0000-0000-0000000000dd';
    await pg.exec(`
      insert into dialer_campaigns (id, name, client_name, airtable_client_id) values ('${DOOMED}', 'Doomed', 'Kintell', 'recK');
      insert into dialer_campaign_members (campaign_id, user_id) values ('${DOOMED}', '${TEAM1}');
      insert into dialer_contacts (campaign_id, full_name, phone_e164) values ('${DOOMED}', 'Gone', '+61499999991');
      insert into dialer_calls (campaign_id, user_id, campaign_name, client_name, twilio_status) values ('${DOOMED}', '${TEAM1}', 'Doomed', 'Kintell', 'completed');
    `);
    const teamDelete = await as(TEAM1, () => pg.query(`delete from dialer_campaigns where id = $1`, [DOOMED]));
    expect(teamDelete.affectedRows).toBe(0);

    const adminDelete = await as(ADMIN, () => pg.query(`delete from dialer_campaigns where id = $1`, [DOOMED]));
    expect(adminDelete.affectedRows).toBe(1);
    expect(await rows(`select 1 from dialer_contacts where full_name = 'Gone'`)).toEqual([]);
    expect(await rows(`select 1 from dialer_campaign_members where campaign_id = $1`, [DOOMED])).toEqual([]);
    expect(await rows(`select campaign_id, campaign_name, client_name from dialer_calls where campaign_name = 'Doomed'`)).toEqual([
      { campaign_id: null, campaign_name: 'Doomed', client_name: 'Kintell' },
    ]);
    await pg.exec(`delete from dialer_calls where campaign_name = 'Doomed'`);
  });
});

describe('custom fields', () => {
  const save = (user: string | null, fields: object[]) => as(user, () => pg.query('select dialer_save_custom_fields($1)', [JSON.stringify(fields)]));

  it('team members save new fields and remember headers; nothing is renamed', async () => {
    await save(TEAM1, [{ key: 'industry', label: 'Industry', alias: 'industry' }]);
    await save(TEAM2, [{ key: 'industry', label: 'Renamed?', alias: 'sector' }, { key: 'industry', label: '', alias: 'sector' }]);
    const [f] = await as(TEAM1, () => rows<{ label: string; aliases: string[] }>(`select label, aliases from dialer_custom_fields where key = 'industry'`));
    expect(f.label).toBe('Industry');
    expect([...f.aliases].sort()).toEqual(['industry', 'sector']);
  });

  it('portal clients and signed-out visitors cannot', async () => {
    await expect(save(CLIENT, [{ key: 'x', label: 'X', alias: 'x' }])).rejects.toThrow(/Maronly team/);
    await pg.exec('set role anon');
    try {
      await expect(pg.query('select dialer_save_custom_fields($1)', ['[]'])).rejects.toThrow(/permission denied/);
    } finally {
      await pg.exec('reset role');
    }
    await expect(as(TEAM1, () => pg.query(`insert into dialer_custom_fields (key, label) values ('sneaky', 'S')`))).rejects.toThrow();
  });
});

describe('contacts belong to a client', () => {
  it('take their client from the campaign, and follow it if the campaign changes client', async () => {
    const [a] = await rows<{ airtable_client_id: string; client_name: string }>(`select airtable_client_id, client_name from dialer_contacts where full_name = 'A'`);
    expect(a).toEqual({ airtable_client_id: 'recKintell', client_name: 'Kintell' });
    await pg.exec(`update dialer_campaigns set airtable_client_id = 'recOther', client_name = 'Other co' where id = '${OTHER_CAMPAIGN}'`);
    expect(await rows(`select client_name from dialer_contacts where full_name = 'Elsewhere'`)).toEqual([{ client_name: 'Other co' }]);
    await pg.exec(`update dialer_campaigns set airtable_client_id = 'recMorfless', client_name = 'Morfless' where id = '${OTHER_CAMPAIGN}'`);
  });

  it('flags numbers the same client already has, in any of its campaigns, but not other clients', async () => {
    const second = '10000000-0000-0000-0000-0000000000b1';
    await pg.exec(`insert into dialer_campaigns (id, name, client_name, airtable_client_id) values ('${second}', 'Kintell Nov', 'Kintell', 'recKintell')`);
    await pg.exec(`insert into dialer_campaign_members (campaign_id, user_id) values ('${second}', '${TEAM1}')`);
    // +61411111111 is A in Kintell Oct; +64211234567 is Elsewhere, a Morfless contact.
    const found = await as(TEAM1, () => rows<{ dialer_existing_phones: string }>('select * from dialer_existing_phones($1, $2)', [second, ['+61411111111', '+64211234567', '+61499000000']]));
    expect(found.map((r) => r.dialer_existing_phones)).toEqual(['+61411111111']);
    await expect(as(TEAM1, () => pg.query('select * from dialer_existing_phones($1, $2)', [OTHER_CAMPAIGN, ['+61411111111']]))).rejects.toThrow(/not assigned/);
    await pg.exec(`delete from dialer_campaigns where id = '${second}'`);
  });
});

describe('campaign assignment', () => {
  it('allows one team member per campaign, plus admins', async () => {
    const id = '10000000-0000-0000-0000-0000000000a1';
    await pg.exec(`insert into dialer_campaigns (id, name, client_name, airtable_client_id) values ('${id}', 'Solo', 'Kintell', 'recKintell')`);
    await pg.exec(`insert into dialer_campaign_members (campaign_id, user_id) values ('${id}', '${TEAM1}'), ('${id}', '${ADMIN}')`);
    await expect(pg.exec(`insert into dialer_campaign_members (campaign_id, user_id) values ('${id}', '${TEAM2}')`)).rejects.toThrow(/one team member/);
    // Swapping: remove the old one first, then add the new one.
    await pg.exec(`delete from dialer_campaign_members where campaign_id = '${id}' and user_id = '${TEAM1}'`);
    await pg.exec(`insert into dialer_campaign_members (campaign_id, user_id) values ('${id}', '${TEAM2}')`);
    await pg.exec(`delete from dialer_campaigns where id = '${id}'`);
  });
});

describe('campaign completion', () => {
  it('completes when every contact is wrapped up, and reopens when contacts are added', async () => {
    const id = '10000000-0000-0000-0000-0000000000c1';
    const status = async () => (await rows<{ status: string }>('select status from dialer_campaigns where id = $1', [id]))[0].status;
    await pg.exec(`
      insert into dialer_campaigns (id, name, client_name, airtable_client_id, status) values ('${id}', 'Small', 'Kintell', 'recKintell', 'active');
      insert into dialer_contacts (campaign_id, full_name, phone_e164) values ('${id}', 'X', '+61480000001'), ('${id}', 'Y', '+61480000002');
    `);
    await pg.exec(`update dialer_contacts set status = 'done' where campaign_id = '${id}' and full_name = 'X'`);
    expect(await status()).toBe('active');
    await pg.exec(`update dialer_contacts set status = 'bad_number' where campaign_id = '${id}' and full_name = 'Y'`);
    expect(await status()).toBe('completed');
    await pg.exec(`insert into dialer_contacts (campaign_id, full_name, phone_e164) values ('${id}', 'Z', '+61480000003')`);
    expect(await status()).toBe('active');
    // Paused campaigns stay paused.
    await pg.exec(`update dialer_campaigns set status = 'paused' where id = '${id}'; update dialer_contacts set status = 'done' where campaign_id = '${id}'`);
    expect(await status()).toBe('paused');
    await pg.exec(`delete from dialer_campaigns where id = '${id}'`);
  });
});

describe('agent names', () => {
  it('follow the rep when their profile name changes', async () => {
    await pg.exec(`insert into dialer_calls (user_id, agent_name, twilio_status) values ('${TEAM1}', 't1@x', 'completed')`);
    await pg.exec(`update profiles set display_name = 'Tom Moore' where id = '${TEAM1}'`);
    const names = await rows<{ agent_name: string }>(`select distinct agent_name from dialer_calls where user_id = '${TEAM1}'`);
    expect(names).toEqual([{ agent_name: 'Tom Moore' }]);
    await pg.exec(`update profiles set display_name = null where id = '${TEAM1}'`);
    const [after] = await rows<{ agent_name: string }>(`select distinct agent_name from dialer_calls where user_id = '${TEAM1}'`);
    expect(after.agent_name).toBe('t1@x');
    await pg.exec(`delete from dialer_calls where user_id = '${TEAM1}'`);
  });

  it('only admins set profile pictures', async () => {
    await expect(as(TEAM1, () => pg.query('select dialer_set_avatar($1, $2)', [TEAM1, 'me.jpg']))).rejects.toThrow(/Only admins/);
    await as(ADMIN, () => pg.query('select dialer_set_avatar($1, $2)', [TEAM1, `${TEAM1}/1.jpg`]));
    await as(ADMIN, () => pg.query('select dialer_set_avatar($1, $2)', [CLIENT, 'nope.jpg']));
    const set = await rows<{ id: string; avatar_url: string | null }>('select id, avatar_url from profiles where id in ($1, $2) order by id', [TEAM1, CLIENT]);
    expect(set).toEqual([
      { id: TEAM1, avatar_url: `${TEAM1}/1.jpg` },
      { id: CLIENT, avatar_url: null },
    ]);
  });

  it('dialer_users includes profile pictures', async () => {
    await pg.exec(`update profiles set avatar_url = 'https://i.imgur.com/x.png' where id = '${TEAM2}'`);
    const users = await as(ADMIN, () => rows<{ id: string; avatar_url: string | null }>('select id, avatar_url from dialer_users()'));
    expect(users.find((u) => u.id === TEAM2)?.avatar_url).toBe('https://i.imgur.com/x.png');
  });
});

describe('stats', () => {
  it('campaign_stats and call_stats run', async () => {
    await pg.exec(`insert into dialer_calls (campaign_id, user_id, agent_name, twilio_status, answered_by) values ('${CAMPAIGN}', '${TEAM1}', 'T1', 'completed', 'human')`);
    const [s] = await as(TEAM1, () => rows<{ dials_today: number; connects_today: number }>('select * from dialer_campaign_stats where campaign_id = $1', [CAMPAIGN]));
    expect(s).toMatchObject({ dials_today: 1, connects_today: 1 });
    const daily = await as(TEAM1, () => rows<{ dials: number; connects: number }>(`select * from dialer_call_stats(now() - interval '1 day', now() + interval '1 day')`));
    expect(daily[0]).toMatchObject({ dials: 1, connects: 1 });
    await pg.exec(`update dialer_calls set client_name = 'Kintell' where campaign_id = '${CAMPAIGN}'`);
    const kintell = await as(TEAM1, () => rows<{ dials: number }>(`select * from dialer_call_stats(now() - interval '1 day', now() + interval '1 day', null, 'Kintell')`));
    expect(kintell[0]).toMatchObject({ dials: 1 });
    expect(await as(TEAM1, () => rows(`select * from dialer_call_stats(now() - interval '1 day', now() + interval '1 day', null, 'Morfless')`))).toEqual([]);
    // The Campaigns metrics are the caller's own calls, even for admins.
    expect(await as(ADMIN, () => rows(`select * from dialer_call_stats(now() - interval '1 day', now() + interval '1 day')`))).toEqual([]);
    const perf = await as(ADMIN, () => rows<{ user_id: string; client_name: string; dials: number; connects: number }>(`select * from dialer_performance_stats(now() - interval '1 day', now() + interval '1 day')`));
    expect(perf).toContainEqual(expect.objectContaining({ user_id: TEAM1, client_name: 'Kintell', dials: 1, connects: 1 }));
    expect(await as(TEAM2, () => rows(`select * from dialer_performance_stats(now() - interval '1 day', now() + interval '1 day')`))).toEqual([]);
  });
});
