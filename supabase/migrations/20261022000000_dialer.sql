-- Maronly Dialer: campaigns, contacts, calls, SMS and phone numbers.
-- Runs on the same Supabase project as the portal (uses public.profiles and public.user_role from its migrations).
-- Paste into the SQL editor and run once. Safe to re-run.
--
-- Access:
--   admin: everything.
--   team:  only campaigns they're a member of (campaign_members), and only calls they made themselves.
--   client (portal users): nothing. The dialer's functions also refuse them.

-- ── Profiles ────────────────────────────────────────────────────────────────────────────────────────────────
-- Shown as the agent name on calls ("Agent Name" in the portal). Falls back to the email when empty.
alter table public.profiles add column if not exists display_name text;

-- ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.is_dialer_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('team', 'admin'))
$$;

create or replace function public.is_dialer_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
$$;

create or replace function public.dialer_set_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── Phone numbers (Twilio) ──────────────────────────────────────────────────────────────────────────────────
create table if not exists public.dialer_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  e164 text not null unique,
  twilio_sid text unique,
  label text,
  -- The client this number belongs to (Airtable Client Company). Their campaigns call and text from it; several
  -- reps can share it.
  client_name text,
  -- Used when the campaign's client has no number of its own.
  is_default boolean not null default false,
  -- Storage path in the 'dialer-greetings' bucket; null = the standard spoken greeting.
  voicemail_greeting_path text,
  created_at timestamptz not null default now()
);

-- ── Campaigns ───────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.dialer_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Airtable Clients → Client Company, spelt exactly (the portal matches calls on it).
  client_name text not null,
  -- Airtable Clients record id (rec…), used to link created Leads.
  airtable_client_id text not null,
  caller_number_id uuid references public.dialer_phone_numbers(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  max_attempts int not null default 3 check (max_attempts between 1 and 20),
  retry_after_minutes int not null default 1440 check (retry_after_minutes >= 5),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dialer_campaign_members (
  campaign_id uuid not null references public.dialer_campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (campaign_id, user_id)
);
create index if not exists dialer_campaign_members_user on public.dialer_campaign_members (user_id);

create or replace function public.dialer_can_access_campaign(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_dialer_admin()
      or (is_dialer_user() and exists (select 1 from dialer_campaign_members where campaign_id = cid and user_id = auth.uid()))
$$;

-- ── Contacts (call lists) ───────────────────────────────────────────────────────────────────────────────────
create table if not exists public.dialer_contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.dialer_campaigns(id) on delete cascade,
  full_name text,
  first_name text,
  company text,
  title text,
  email text,
  -- AU (+614…) or NZ (+642…) mobiles only.
  phone_e164 text not null check (phone_e164 ~ '^\+(614[0-9]{8}|642[0-9]{7,9})$'),
  phone_raw text,
  linkedin text,
  website text,
  custom jsonb not null default '{}',
  status text not null default 'new' check (status in ('new', 'callback', 'done', 'do_not_call', 'bad_number')),
  attempts int not null default 0,
  last_called_at timestamptz,
  next_attempt_at timestamptz,
  last_disposition text,
  -- Power dialer queue lock: the rep currently holding this contact.
  locked_by uuid references auth.users(id) on delete set null,
  locked_at timestamptz,
  airtable_lead_id text,
  source text not null default 'csv' check (source in ('csv', 'api')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, phone_e164)
);
create index if not exists dialer_contacts_queue on public.dialer_contacts (campaign_id, status, next_attempt_at);
create index if not exists dialer_contacts_phone on public.dialer_contacts (phone_e164);

-- ── Calls: the one call log (dialer calls, inbound voicemails, JustCall history) ───────────────────────────
create table if not exists public.dialer_calls (
  id uuid primary key default gen_random_uuid(),
  direction text not null default 'outbound' check (direction in ('outbound', 'inbound')),
  kind text not null default 'call' check (kind in ('call', 'voicemail')),
  source text not null default 'dialer' check (source in ('dialer', 'justcall')),
  campaign_id uuid references public.dialer_campaigns(id) on delete set null,
  contact_id uuid references public.dialer_contacts(id) on delete set null,
  -- The rep who made the call (outbound) or should follow up (inbound).
  user_id uuid references auth.users(id) on delete set null,
  agent_name text,
  -- Snapshot at call time, so the log survives contacts/campaigns being deleted.
  client_name text,
  campaign_name text,
  full_name text,
  email text,
  company text,
  linkedin text,
  website text,
  phone_e164 text,
  from_number text,
  to_number text,
  -- Twilio
  twilio_call_sid text unique,
  twilio_child_sid text,
  twilio_status text,
  answered_by text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_s int,
  -- Outcome
  pickup_status text check (pickup_status in ('Human Pickup', 'Machine Pickup', 'Unanswered', 'Unclassified Pickup', 'Busy', 'Failed')),
  -- 'twilio' = set from Twilio's result; 'agent' = corrected by the rep at wrap-up.
  pickup_source text not null default 'twilio' check (pickup_source in ('twilio', 'agent', 'import')),
  disposition text check (disposition in ('Interested - Appointment Set', 'Interested - Needs Follow-Up', 'Not Interested', 'Left Voicemail',
                                          'No Answer', 'Unqualified Lead', 'Wrong Number', 'Do Not Call', 'Disconnected Number')),
  notes text,
  wrapped_up_at timestamptz,
  -- Recording (file in the 'dialer-recordings' bucket) and transcript
  recording_sid text,
  recording_path text,
  recording_duration_s int,
  transcript_sid text,
  transcript_status text check (transcript_status in ('pending', 'completed', 'failed', 'skipped')),
  transcript text,
  transcript_json jsonb,
  -- Shown to the client in the portal's Cold Call Logs.
  visible boolean not null default true,
  airtable_lead_id text,
  lead_sync_error text,
  -- Inbound voicemails: when the rep listened to it.
  read_at timestamptz,
  justcall_call_id bigint unique,
  justcall_contact_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dialer_calls_client on public.dialer_calls (client_name, started_at desc);
create index if not exists dialer_calls_campaign on public.dialer_calls (campaign_id, started_at desc);
create index if not exists dialer_calls_user on public.dialer_calls (user_id, started_at desc);
create index if not exists dialer_calls_phone on public.dialer_calls (phone_e164, started_at desc);
create index if not exists dialer_calls_contact on public.dialer_calls (contact_id);
create index if not exists dialer_calls_recording_pending on public.dialer_calls (recording_sid) where recording_path is null;
create index if not exists dialer_calls_transcript_pending on public.dialer_calls (transcript_status) where transcript_status = 'pending';

-- ── SMS ─────────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.dialer_sms_messages (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('outbound', 'inbound')),
  contact_id uuid references public.dialer_contacts(id) on delete set null,
  -- Sender (outbound) or the rep to notify (inbound).
  user_id uuid references auth.users(id) on delete set null,
  phone_e164 text not null,
  our_number text not null,
  body text not null,
  twilio_sid text unique,
  status text,
  error text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists dialer_sms_phone on public.dialer_sms_messages (phone_e164, created_at desc);
create index if not exists dialer_sms_user on public.dialer_sms_messages (user_id, created_at desc);
create index if not exists dialer_sms_contact on public.dialer_sms_messages (contact_id);

-- ── Custom contact fields ───────────────────────────────────────────────────────────────────────────────────
-- Extra CSV columns (industry, headcount…) are saved as named fields and reused by later imports. Contacts keep
-- their values in contacts.custom under `key`. `aliases` are the normalised CSV headers mapped to the field before,
-- so the next file with the same header maps itself.
create table if not exists public.dialer_custom_fields (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.dialer_custom_fields enable row level security;
drop policy if exists "Dialer users read custom fields" on public.dialer_custom_fields;
create policy "Dialer users read custom fields" on public.dialer_custom_fields for select to authenticated using (is_dialer_user());
drop policy if exists "Admins manage custom fields" on public.dialer_custom_fields;
create policy "Admins manage custom fields" on public.dialer_custom_fields for all to authenticated using (is_dialer_admin()) with check (is_dialer_admin());

-- Called by CSV import (team members can import too): adds new fields and remembers which headers map to which
-- field. Never renames or removes anything. p_fields: [{"key": "industry", "label": "Industry", "alias": "sector"}]
create or replace function public.dialer_save_custom_fields(p_fields jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  f jsonb;
begin
  if not is_dialer_user() then
    raise exception 'Only the Maronly team can import contacts' using errcode = '42501';
  end if;
  for f in select * from jsonb_array_elements(p_fields) loop
    insert into dialer_custom_fields (key, label, aliases)
    values (f->>'key', coalesce(nullif(trim(f->>'label'), ''), f->>'key'), case when coalesce(f->>'alias', '') = '' then '{}' else array[f->>'alias'] end)
    on conflict (key) do update
      set aliases = (select coalesce(array_agg(distinct a), '{}') from unnest(dialer_custom_fields.aliases || excluded.aliases) a);
  end loop;
end $$;

-- ── Pickup Status from Twilio ───────────────────────────────────────────────────────────────────────────────
-- Twilio reports the prospect's leg in separate callbacks (call status, answering machine detection) that can
-- arrive in any order or at the same moment. Each callback only writes its raw column; this trigger works out
-- Pickup Status from the merged row, so neither can overwrite the other. A rep's correction (pickup_source =
-- 'agent') is never touched.
--   status:      CallStatus of the <Number> leg (initiated, ringing, in-progress, completed, busy, no-answer, failed, canceled)
--   answered_by: AMD result (human, machine_start, machine_end_*, fax, unknown)
create or replace function public.dialer_pickup_status_from(p_status text, p_answered_by text, p_answered boolean) returns text
language sql immutable set search_path = public as $$
  select case
    when p_answered_by = 'human' then 'Human Pickup'
    when p_answered_by like 'machine%' or p_answered_by = 'fax' then 'Machine Pickup'
    when p_answered_by = 'unknown' then 'Unclassified Pickup'
    when p_status = 'busy' then 'Busy'
    when p_status = 'failed' then 'Failed'
    -- canceled = the rep hung up while it was still ringing
    when p_status in ('no-answer', 'canceled') then case when p_answered then 'Unclassified Pickup' else 'Unanswered' end
    -- completed = answered, but AMD never reported (e.g. hung up within a second or two)
    when p_status = 'completed' then 'Unclassified Pickup'
    when p_answered then 'Unclassified Pickup'
  end
$$;

create or replace function public.dialer_calls_set_pickup() returns trigger
language plpgsql set search_path = public as $$
begin
  new.pickup_status = coalesce(dialer_pickup_status_from(new.twilio_status, new.answered_by, new.answered_at is not null), new.pickup_status);
  return new;
end $$;

drop trigger if exists dialer_calls_pickup on public.dialer_calls;
create trigger dialer_calls_pickup before insert or update of twilio_status, answered_by, answered_at on public.dialer_calls
  for each row when (new.pickup_source = 'twilio' and new.source = 'dialer' and new.direction = 'outbound')
  execute function public.dialer_calls_set_pickup();

-- ── updated_at triggers ─────────────────────────────────────────────────────────────────────────────────────
drop trigger if exists dialer_campaigns_updated_at on public.dialer_campaigns;
create trigger dialer_campaigns_updated_at before update on public.dialer_campaigns for each row execute function public.dialer_set_updated_at();
drop trigger if exists dialer_contacts_updated_at on public.dialer_contacts;
create trigger dialer_contacts_updated_at before update on public.dialer_contacts for each row execute function public.dialer_set_updated_at();
drop trigger if exists dialer_calls_updated_at on public.dialer_calls;
create trigger dialer_calls_updated_at before update on public.dialer_calls for each row execute function public.dialer_set_updated_at();

-- ── Row level security ──────────────────────────────────────────────────────────────────────────────────────
-- Writes that involve Twilio or Airtable (calls, wrap-ups, SMS) go through Netlify Functions with the service
-- role key, which bypasses RLS. These policies cover what the browser does directly.
alter table public.dialer_phone_numbers enable row level security;
alter table public.dialer_campaigns enable row level security;
alter table public.dialer_campaign_members enable row level security;
alter table public.dialer_contacts enable row level security;
alter table public.dialer_calls enable row level security;
alter table public.dialer_sms_messages enable row level security;

drop policy if exists "Dialer users read numbers" on public.dialer_phone_numbers;
create policy "Dialer users read numbers" on public.dialer_phone_numbers for select to authenticated using (is_dialer_user());
drop policy if exists "Admins manage numbers" on public.dialer_phone_numbers;
create policy "Admins manage numbers" on public.dialer_phone_numbers for all to authenticated using (is_dialer_admin()) with check (is_dialer_admin());

drop policy if exists "Members read campaigns" on public.dialer_campaigns;
create policy "Members read campaigns" on public.dialer_campaigns for select to authenticated using (dialer_can_access_campaign(id));
drop policy if exists "Admins manage campaigns" on public.dialer_campaigns;
create policy "Admins manage campaigns" on public.dialer_campaigns for all to authenticated using (is_dialer_admin()) with check (is_dialer_admin());

drop policy if exists "Read own memberships" on public.dialer_campaign_members;
create policy "Read own memberships" on public.dialer_campaign_members for select to authenticated using (user_id = (select auth.uid()) or is_dialer_admin());
drop policy if exists "Admins manage memberships" on public.dialer_campaign_members;
create policy "Admins manage memberships" on public.dialer_campaign_members for all to authenticated using (is_dialer_admin()) with check (is_dialer_admin());

drop policy if exists "Members read contacts" on public.dialer_contacts;
create policy "Members read contacts" on public.dialer_contacts for select to authenticated using (dialer_can_access_campaign(campaign_id));
-- Members can import lists into their campaigns.
drop policy if exists "Members add contacts" on public.dialer_contacts;
create policy "Members add contacts" on public.dialer_contacts for insert to authenticated with check (dialer_can_access_campaign(campaign_id));
drop policy if exists "Admins edit contacts" on public.dialer_contacts;
create policy "Admins edit contacts" on public.dialer_contacts for update to authenticated using (is_dialer_admin()) with check (is_dialer_admin());
drop policy if exists "Admins delete contacts" on public.dialer_contacts;
create policy "Admins delete contacts" on public.dialer_contacts for delete to authenticated using (is_dialer_admin());

-- Reps only ever see calls they made themselves; admins see every call.
drop policy if exists "Read calls" on public.dialer_calls;
create policy "Read calls" on public.dialer_calls for select to authenticated
  using (is_dialer_admin() or (is_dialer_user() and user_id = (select auth.uid())));
-- The browser may only mark its own voicemails as read (column grant below limits it to read_at).
drop policy if exists "Mark own voicemails read" on public.dialer_calls;
create policy "Mark own voicemails read" on public.dialer_calls for update to authenticated
  using (is_dialer_admin() or (is_dialer_user() and user_id = (select auth.uid())))
  with check (is_dialer_admin() or (is_dialer_user() and user_id = (select auth.uid())));

drop policy if exists "Read messages" on public.dialer_sms_messages;
create policy "Read messages" on public.dialer_sms_messages for select to authenticated
  using (is_dialer_admin() or (is_dialer_user() and (user_id = (select auth.uid())
    or exists (select 1 from dialer_contacts c where c.id = contact_id and dialer_can_access_campaign(c.campaign_id)))));
drop policy if exists "Mark own messages read" on public.dialer_sms_messages;
create policy "Mark own messages read" on public.dialer_sms_messages for update to authenticated
  using (is_dialer_admin() or (is_dialer_user() and user_id = (select auth.uid())))
  with check (is_dialer_admin() or (is_dialer_user() and user_id = (select auth.uid())));

revoke insert, update, delete on public.dialer_calls from anon, authenticated;
grant update (read_at) on public.dialer_calls to authenticated;
revoke insert, update, delete on public.dialer_sms_messages from anon, authenticated;
grant update (read_at) on public.dialer_sms_messages to authenticated;
-- Contacts: the browser can insert (import) but only admins update; the queue columns change through the functions below.
revoke update on public.dialer_contacts from anon;

-- ── Power dialer queue ──────────────────────────────────────────────────────────────────────────────────────
-- Hands the caller the next contact to dial and locks it to them. `skip locked` means two reps can never get the
-- same contact. A lock older than 30 minutes is treated as abandoned (closed tab, lost connection).
create or replace function public.dialer_claim_next_contact(p_campaign_id uuid) returns setof public.dialer_contacts
language plpgsql security definer set search_path = public as $$
declare
  camp public.dialer_campaigns;
  picked uuid;
begin
  if not dialer_can_access_campaign(p_campaign_id) then
    raise exception 'You are not assigned to this campaign' using errcode = '42501';
  end if;
  select * into camp from dialer_campaigns where id = p_campaign_id;
  if camp.status <> 'active' then
    raise exception 'This campaign is %', camp.status using errcode = 'P0001';
  end if;

  -- Let go of anything this rep was still holding in this campaign.
  update dialer_contacts set locked_by = null, locked_at = null where campaign_id = p_campaign_id and locked_by = auth.uid();

  select id into picked from dialer_contacts
  where campaign_id = p_campaign_id
    and status in ('new', 'callback')
    and attempts < camp.max_attempts
    and (next_attempt_at is null or next_attempt_at <= now())
    and (locked_by is null or locked_at < now() - interval '30 minutes')
    -- Do Not Call follows the number into lists imported later.
    and not exists (select 1 from dialer_contacts d where d.phone_e164 = dialer_contacts.phone_e164 and d.status = 'do_not_call')
  order by coalesce(next_attempt_at, created_at), created_at
  limit 1
  for update skip locked;

  if picked is null then
    return;
  end if;

  return query update dialer_contacts set locked_by = auth.uid(), locked_at = now() where id = picked returning *;
end $$;

-- Gives a contact back to the queue without a call (Skip / Stop). Skip pushes it back by the campaign's retry delay.
create or replace function public.dialer_release_contact(p_contact_id uuid, p_skip boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  update dialer_contacts c
  set locked_by = null,
      locked_at = null,
      next_attempt_at = case when p_skip then now() + make_interval(mins => camp.retry_after_minutes) else c.next_attempt_at end
  from dialer_campaigns camp
  where c.id = p_contact_id and camp.id = c.campaign_id and c.locked_by = auth.uid();
end $$;

-- Team list for admin screens and agent names.
create or replace function public.dialer_users() returns table (id uuid, email text, display_name text, role public.user_role)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name, p.role from profiles p
  where p.role in ('team', 'admin') and is_dialer_user()
  order by coalesce(p.display_name, p.email)
$$;

-- Only signed-in users may call the dialer's functions (they also check the caller's role themselves).
revoke execute on function public.is_dialer_user(), public.is_dialer_admin(), public.dialer_can_access_campaign(uuid),
  public.dialer_claim_next_contact(uuid), public.dialer_release_contact(uuid, boolean), public.dialer_users(),
  public.dialer_save_custom_fields(jsonb) from public, anon;
grant execute on function public.is_dialer_user(), public.is_dialer_admin(), public.dialer_can_access_campaign(uuid),
  public.dialer_claim_next_contact(uuid), public.dialer_release_contact(uuid, boolean), public.dialer_users(),
  public.dialer_save_custom_fields(jsonb) to authenticated, service_role;

-- ── Stats ───────────────────────────────────────────────────────────────────────────────────────────────────
create or replace view public.dialer_campaign_stats with (security_invoker = true) as
with today as (select (date_trunc('day', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney') as start)
select
  c.id as campaign_id,
  (select count(*) from dialer_contacts k where k.campaign_id = c.id)::int as contacts_total,
  (select count(*) from dialer_contacts k where k.campaign_id = c.id and k.status in ('new', 'callback') and k.attempts < c.max_attempts)::int as contacts_remaining,
  (select count(*) from dialer_calls x, today where x.campaign_id = c.id and x.direction = 'outbound' and x.started_at >= today.start)::int as dials_today,
  (select count(*) from dialer_calls x, today where x.campaign_id = c.id and x.direction = 'outbound' and x.started_at >= today.start and x.pickup_status = 'Human Pickup')::int as connects_today,
  (select count(*) from dialer_calls x where x.campaign_id = c.id and x.direction = 'outbound')::int as dials_total,
  (select count(*) from dialer_calls x where x.campaign_id = c.id and x.direction = 'outbound' and x.pickup_status = 'Human Pickup')::int as connects_total
from dialer_campaigns c;

-- Daily totals per rep (optionally for one campaign), for the Stats page. Runs with the caller's access (RLS on
-- calls applies). One row per day per rep keeps it well under PostgREST's 1000-row limit.
drop function if exists public.dialer_call_stats(timestamptz, timestamptz, uuid);
create or replace function public.dialer_call_stats(p_from timestamptz, p_to timestamptz, p_campaign_id uuid default null)
returns table (day date, user_id uuid, agent_name text, dials int, connects int, machine int, unanswered int,
               appointments int, follow_ups int, talk_seconds int)
language sql stable security invoker set search_path = public as $$
  select (x.started_at at time zone 'Australia/Sydney')::date as day,
         x.user_id,
         max(x.agent_name) as agent_name,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as connects,
         count(*) filter (where x.pickup_status = 'Machine Pickup')::int as machine,
         count(*) filter (where x.pickup_status in ('Unanswered', 'Busy', 'Failed'))::int as unanswered,
         count(*) filter (where x.disposition = 'Interested - Appointment Set')::int as appointments,
         count(*) filter (where x.disposition = 'Interested - Needs Follow-Up')::int as follow_ups,
         coalesce(sum(x.duration_s) filter (where x.pickup_status = 'Human Pickup'), 0)::int as talk_seconds
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer'
    and x.started_at >= p_from and x.started_at < p_to
    and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  group by 1, 2
  order by 1 desc
$$;

-- ── Realtime (live call status, new texts and voicemails) ───────────────────────────────────────────────────
do $$
begin
  alter publication supabase_realtime add table public.dialer_calls;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.dialer_sms_messages;
exception when duplicate_object then null;
end $$;

-- ── Storage ─────────────────────────────────────────────────────────────────────────────────────────────────
-- dialer-recordings: private; the functions hand out short-lived signed URLs.
-- dialer-greetings: private; admins upload custom voicemail greetings.
insert into storage.buckets (id, name, public) values ('dialer-recordings', 'dialer-recordings', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('dialer-greetings', 'dialer-greetings', false) on conflict (id) do nothing;

drop policy if exists "Dialer admins manage greetings" on storage.objects;
create policy "Dialer admins manage greetings" on storage.objects for all to authenticated
  using (bucket_id = 'dialer-greetings' and public.is_dialer_admin())
  with check (bucket_id = 'dialer-greetings' and public.is_dialer_admin());
