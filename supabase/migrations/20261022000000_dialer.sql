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
-- Profile picture shown on campaigns' team lists: a path in the private 'dialer-avatars' bucket (uploaded on Manage
-- campaigns), or a full https link to an image hosted elsewhere.
alter table public.profiles add column if not exists avatar_url text;

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
  -- draft: admins only. active: dialing. paused: visible to the team but can't be opened. completed: every contact
  -- wrapped up (set automatically, see dialer_campaign_completion).
  status text not null default 'active' check (status in ('draft', 'active', 'paused', 'completed')),
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

-- One team member per campaign (there's no way yet to split a campaign's contacts between reps). Admins can dial
-- every campaign without being members. Checked on new assignments only.
create or replace function public.dialer_one_team_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from profiles where id = new.user_id and role::text = 'team')
     and exists (select 1 from dialer_campaign_members m join profiles p on p.id = m.user_id
                 where m.campaign_id = new.campaign_id and m.user_id <> new.user_id and p.role::text = 'team') then
    raise exception 'A campaign can only be assigned to one team member' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public.dialer_one_team_member() from public, anon, authenticated;
drop trigger if exists dialer_campaign_members_one_team on public.dialer_campaign_members;
create trigger dialer_campaign_members_one_team before insert or update on public.dialer_campaign_members
  for each row execute function public.dialer_one_team_member();

-- Statuses were active / paused / archived; archived campaigns become completed.
alter table public.dialer_campaigns drop constraint if exists dialer_campaigns_status_check;
update public.dialer_campaigns set status = 'completed' where status = 'archived';
alter table public.dialer_campaigns add constraint dialer_campaigns_status_check check (status in ('draft', 'active', 'paused', 'completed'));

create or replace function public.dialer_can_access_campaign(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  -- Team members see the campaigns they're assigned to, except drafts.
  select is_dialer_admin()
      or (is_dialer_user()
          and exists (select 1 from dialer_campaign_members where campaign_id = cid and user_id = auth.uid())
          and exists (select 1 from dialer_campaigns where id = cid and status <> 'draft'))
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
  updated_at timestamptz not null default now()
);
-- A number may appear more than once in a campaign; the import screen flags duplicates and removes them by default.
alter table public.dialer_contacts drop constraint if exists dialer_contacts_campaign_id_phone_e164_key;
create index if not exists dialer_contacts_queue on public.dialer_contacts (campaign_id, status, next_attempt_at);
create index if not exists dialer_contacts_phone on public.dialer_contacts (phone_e164);

-- Every contact belongs to its campaign's client, so duplicates are checked per client (the same person can be a
-- contact for two different clients). Filled in from the campaign; see dialer_contact_client.
alter table public.dialer_contacts add column if not exists airtable_client_id text, add column if not exists client_name text;
create index if not exists dialer_contacts_client_phone on public.dialer_contacts (airtable_client_id, phone_e164);

-- Callback: the rep who booked it. Only they get the contact back, from its callback time (next_attempt_at).
alter table public.dialer_contacts add column if not exists callback_user_id uuid references auth.users(id) on delete set null;
create index if not exists dialer_contacts_callbacks on public.dialer_contacts (callback_user_id, next_attempt_at) where status = 'callback';

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
  -- Checked by dialer_calls_disposition_check (below the table) so the list can grow.
  disposition text,
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
alter table public.dialer_calls drop constraint if exists dialer_calls_disposition_check;
alter table public.dialer_calls add constraint dialer_calls_disposition_check check (disposition in (
  'Interested - Appointment Set', 'Interested - Needs Follow-Up', 'Callback', 'Not Interested', 'Left Voicemail', 'No Answer',
  'Unqualified Lead', 'Wrong Number', 'Do Not Call', 'Disconnected Number'));
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
    -- 'unknown': AMD couldn't decide, which in practice is a carrier message ("your call has been forwarded to
    -- voicemail") or a pickup that hangs up straight away. Reps corrected every one of these to Machine Pickup or
    -- Unanswered, never Human Pickup, so it's labelled Machine Pickup (the rep can still change it).
    when p_answered_by like 'machine%' or p_answered_by in ('fax', 'unknown') then 'Machine Pickup'
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

-- A campaign is completed once every contact is wrapped up, and goes back to active if contacts are added later.
-- Drafts and paused campaigns are left alone.
create or replace function public.dialer_campaign_completion() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cid uuid := coalesce(new.campaign_id, old.campaign_id);
begin
  if exists (select 1 from dialer_contacts where campaign_id = cid and status in ('new', 'callback')) then
    update dialer_campaigns set status = 'active' where id = cid and status = 'completed';
  elsif exists (select 1 from dialer_contacts where campaign_id = cid) then
    update dialer_campaigns set status = 'completed' where id = cid and status = 'active';
  end if;
  return null;
end $$;
revoke execute on function public.dialer_campaign_completion() from public, anon, authenticated;
drop trigger if exists dialer_contacts_completion on public.dialer_contacts;
create trigger dialer_contacts_completion after insert or delete or update of status on public.dialer_contacts
  for each row execute function public.dialer_campaign_completion();
update public.dialer_campaigns c set status = 'completed'
where c.status = 'active'
  and exists (select 1 from dialer_contacts k where k.campaign_id = c.id)
  and not exists (select 1 from dialer_contacts k where k.campaign_id = c.id and k.status in ('new', 'callback'));

-- Contacts take their client from their campaign, on insert and whenever the campaign's client changes.
create or replace function public.dialer_contact_client() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select airtable_client_id, client_name into new.airtable_client_id, new.client_name from dialer_campaigns where id = new.campaign_id;
  return new;
end $$;
revoke execute on function public.dialer_contact_client() from public, anon, authenticated;
drop trigger if exists dialer_contacts_client on public.dialer_contacts;
create trigger dialer_contacts_client before insert or update of campaign_id on public.dialer_contacts
  for each row execute function public.dialer_contact_client();

create or replace function public.dialer_campaign_client_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update dialer_contacts set airtable_client_id = new.airtable_client_id, client_name = new.client_name where campaign_id = new.id;
  return null;
end $$;
revoke execute on function public.dialer_campaign_client_changed() from public, anon, authenticated;
drop trigger if exists dialer_campaigns_client on public.dialer_campaigns;
create trigger dialer_campaigns_client after update of airtable_client_id, client_name on public.dialer_campaigns
  for each row when (old.airtable_client_id is distinct from new.airtable_client_id or old.client_name is distinct from new.client_name)
  execute function public.dialer_campaign_client_changed();

update public.dialer_contacts k set airtable_client_id = c.airtable_client_id, client_name = c.client_name
from public.dialer_campaigns c
where c.id = k.campaign_id and (k.airtable_client_id is distinct from c.airtable_client_id or k.client_name is distinct from c.client_name);

-- Airtable Blocklists 2.0 record for a human pickup ('skipped' for calls from before this was added).
alter table public.dialer_calls add column if not exists blocklist_record_id text;
update public.dialer_calls set blocklist_record_id = 'skipped'
where blocklist_record_id is null and pickup_status = 'Human Pickup' and wrapped_up_at < '2026-10-25T00:00:00Z';
-- When the call's transcript was written to its Airtable lead (Leads → Cold Call Transcript); null until then.
alter table public.dialer_calls add column if not exists transcript_synced_at timestamptz;
create index if not exists dialer_calls_transcript_unsynced on public.dialer_calls (id)
  where airtable_lead_id is not null and transcript_status = 'completed' and transcript_synced_at is null;

-- Calls keep the rep's name for the portal and stats; renaming someone renames them on all their calls.
create or replace function public.dialer_sync_agent_name() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update dialer_calls set agent_name = coalesce(nullif(trim(new.display_name), ''), new.email)
  where user_id = new.id and agent_name is distinct from coalesce(nullif(trim(new.display_name), ''), new.email);
  return new;
end $$;
revoke execute on function public.dialer_sync_agent_name() from public, anon, authenticated;
drop trigger if exists dialer_profiles_agent_name on public.profiles;
create trigger dialer_profiles_agent_name after update of display_name, email on public.profiles
  for each row execute function public.dialer_sync_agent_name();

-- ── Row level security ──────────────────────────────────────────────────────────────────────────────────────
-- Writes that involve Twilio or Airtable (calls, wrap-ups, SMS) go through Netlify Functions with the service
-- role key, which bypasses RLS. These policies cover what the browser does directly.
alter table public.dialer_phone_numbers enable row level security;
alter table public.dialer_campaigns enable row level security;
alter table public.dialer_campaign_members enable row level security;
alter table public.dialer_contacts enable row level security;
alter table public.dialer_calls enable row level security;
alter table public.dialer_sms_messages enable row level security;

-- Only admins see the numbers; the server picks the caller number for calls and texts.
drop policy if exists "Dialer users read numbers" on public.dialer_phone_numbers;
drop policy if exists "Admins read numbers" on public.dialer_phone_numbers;
create policy "Admins read numbers" on public.dialer_phone_numbers for select to authenticated using (is_dialer_admin());
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
drop policy if exists "Admins add contacts" on public.dialer_contacts;
create policy "Admins add contacts" on public.dialer_contacts for insert to authenticated with check (is_dialer_admin());
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
-- Contacts: admins insert (import) and update from the browser; the queue columns change through the functions below.
revoke update on public.dialer_contacts from anon;

-- ── Power dialer queue ──────────────────────────────────────────────────────────────────────────────────────
-- Hands the caller the next contact to dial and locks it to them. `skip locked` means two reps can never get the
-- same contact. A lock older than 30 minutes is treated as abandoned (closed tab, lost connection).
create or replace function public.dialer_claim_next(p_campaign_id uuid, p_keep_contact_id uuid default null) returns setof public.dialer_contacts
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

  -- Let go of anything this rep was still holding in this campaign, except the contact they're on a call with
  -- (p_keep_contact_id: the dialer fetches the next contact while the current call is being wrapped up).
  update dialer_contacts set locked_by = null, locked_at = null
  where campaign_id = p_campaign_id and locked_by = auth.uid() and id is distinct from p_keep_contact_id;

  select id into picked from dialer_contacts
  where campaign_id = p_campaign_id
    and status in ('new', 'callback')
    and (next_attempt_at is null or next_attempt_at <= now())
    and (locked_by is null or locked_at < now() - interval '30 minutes')
    -- A callback only goes back to the rep who booked it.
    and (status <> 'callback' or callback_user_id = auth.uid())
    -- Do Not Call follows the number into lists imported later.
    and not exists (select 1 from dialer_contacts d where d.phone_e164 = dialer_contacts.phone_e164 and d.status = 'do_not_call')
  -- Due callbacks first, then everyone else oldest first.
  order by (status = 'callback') desc, coalesce(next_attempt_at, created_at), created_at
  limit 1
  for update skip locked;

  if picked is null then
    return;
  end if;

  return query update dialer_contacts set locked_by = auth.uid(), locked_at = now() where id = picked returning *;
end $$;

create or replace function public.dialer_claim_next_contact(p_campaign_id uuid) returns setof public.dialer_contacts
language sql security definer set search_path = public as $$
  select * from dialer_claim_next(p_campaign_id, null)
$$;

-- ── Server-side call steps (Netlify functions only) ─────────────────────────────────────────────────────────
-- Each does in one round trip what used to take several queries, to keep starting and saving calls fast.

-- Called by /api/twilio/voice when a rep's browser starts a call: checks the rep may call this contact, picks the
-- caller number (campaign's, else the client's, else the default) and logs the call. Returns {from, to} or {error}.
create or replace function public.dialer_start_call(p_call_id uuid, p_contact_id uuid, p_user_id uuid, p_twilio_call_sid text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles;
  c public.dialer_contacts;
  camp public.dialer_campaigns;
  caller text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server can start calls' using errcode = '42501';
  end if;
  select * into prof from profiles where id = p_user_id;
  if prof.id is null or prof.role::text not in ('team', 'admin') then
    return jsonb_build_object('error', 'user');
  end if;
  select * into c from dialer_contacts where id = p_contact_id;
  if c.id is null then
    return jsonb_build_object('error', 'contact');
  end if;
  select * into camp from dialer_campaigns where id = c.campaign_id;
  if prof.role::text <> 'admin' and not exists (select 1 from dialer_campaign_members where campaign_id = camp.id and user_id = p_user_id) then
    return jsonb_build_object('error', 'member');
  end if;

  caller := coalesce(
    (select e164 from dialer_phone_numbers where id = camp.caller_number_id),
    (select e164 from dialer_phone_numbers where client_name = camp.client_name order by created_at limit 1),
    (select e164 from dialer_phone_numbers where is_default order by created_at limit 1)
  );

  insert into dialer_calls (id, direction, campaign_id, contact_id, user_id, agent_name, client_name, campaign_name, full_name, email,
                            company, linkedin, website, phone_e164, from_number, to_number, twilio_call_sid, twilio_status)
  values (p_call_id, 'outbound', camp.id, c.id, p_user_id, coalesce(nullif(trim(prof.display_name), ''), prof.email), camp.client_name,
          camp.name, c.full_name, c.email, c.company, c.linkedin, c.website, c.phone_e164, caller, c.phone_e164, p_twilio_call_sid,
          case when caller is null then 'failed' else 'initiated' end)
  on conflict (id) do nothing;

  return jsonb_build_object('from', caller, 'to', c.phone_e164);
end $$;

-- Called by /api/wrap-up (dialer_save_wrap_up): saves the rep's pickup status, disposition and notes, and moves the contact on (status
-- worked out by the app). Do Not Call blocks the number in every campaign. Safe to repeat: attempts only go up on
-- the first save. Returns what's needed to create a CRM lead, or {error}.
-- Replaces dialer_wrap_up (which had no callback time).
drop function if exists public.dialer_wrap_up(uuid, uuid, text, text, text, text, text, text);
create or replace function public.dialer_save_wrap_up(p_call_id uuid, p_user_id uuid, p_pickup text, p_disposition text, p_notes text,
                                                 p_contact_status text, p_lead_name text default null, p_lead_email text default null,
                                                 p_callback_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  role_name text;
  x public.dialer_calls;
  camp public.dialer_campaigns;
  first_save boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server can save calls' using errcode = '42501';
  end if;
  select role::text into role_name from profiles where id = p_user_id;
  if role_name is null or role_name not in ('team', 'admin') then
    return jsonb_build_object('error', 'user');
  end if;
  select * into x from dialer_calls where id = p_call_id for update;
  if x.id is null then
    return jsonb_build_object('error', 'not_found');
  end if;
  if x.user_id is distinct from p_user_id and role_name <> 'admin' then
    return jsonb_build_object('error', 'forbidden');
  end if;
  first_save := x.wrapped_up_at is null;

  update dialer_calls set
    disposition = p_disposition,
    notes = nullif(trim(p_notes), ''),
    wrapped_up_at = coalesce(wrapped_up_at, now()),
    pickup_source = case when p_pickup is distinct from pickup_status then 'agent' else pickup_source end,
    pickup_status = p_pickup
  where id = x.id;

  -- The contact follows this call's outcome unless it has been called again since (editing an older call later
  -- mustn't undo what the newer call set); the attempt still counts.
  if x.contact_id is not null and exists (
    select 1 from dialer_calls n where n.contact_id = x.contact_id and n.started_at > x.started_at
  ) then
    update dialer_contacts set attempts = attempts + case when first_save then 1 else 0 end where id = x.contact_id;
  elsif x.contact_id is not null then
    update dialer_contacts set
      attempts = attempts + case when first_save then 1 else 0 end,
      last_called_at = x.started_at,
      last_disposition = p_disposition,
      status = p_contact_status,
      -- Callback: due at the booked time, for this rep only. Any other outcome clears it.
      next_attempt_at = case when p_contact_status = 'callback' then p_callback_at end,
      callback_user_id = case when p_contact_status = 'callback' then p_user_id end,
      locked_by = null,
      locked_at = null,
      -- Keep corrections the rep made in the lead form.
      full_name = coalesce(nullif(trim(p_lead_name), ''), full_name),
      email = coalesce(nullif(trim(p_lead_email), ''), email)
    where id = x.contact_id;
  end if;

  if p_disposition = 'Do Not Call' and x.phone_e164 is not null then
    update dialer_contacts set status = 'do_not_call', locked_by = null, locked_at = null where phone_e164 = x.phone_e164;
  end if;

  select * into camp from dialer_campaigns where id = x.campaign_id;
  return jsonb_build_object(
    'contact_id', x.contact_id,
    'airtable_lead_id', x.airtable_lead_id,
    'campaign_name', camp.name,
    'airtable_client_id', camp.airtable_client_id,
    'linkedin', x.linkedin,
    'website', x.website
  );
end $$;

revoke execute on function public.dialer_start_call(uuid, uuid, uuid, text), public.dialer_save_wrap_up(uuid, uuid, text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.dialer_start_call(uuid, uuid, uuid, text), public.dialer_save_wrap_up(uuid, uuid, text, text, text, text, text, text, timestamptz)
  to service_role;

-- Gives a contact back to the queue without a call (Skip / Stop). Skip moves it to the back of the queue.
create or replace function public.dialer_release_contact(p_contact_id uuid, p_skip boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  update dialer_contacts c
  set locked_by = null,
      locked_at = null,
      next_attempt_at = case when p_skip then now() else c.next_attempt_at end
  where c.id = p_contact_id and c.locked_by = auth.uid();
end $$;

-- CSV import duplicate check: which of these numbers the campaign's client already has as contacts (in any of its
-- campaigns). Only answers for numbers in the file being imported.
create or replace function public.dialer_existing_phones(p_campaign_id uuid, p_phones text[]) returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  if not dialer_can_access_campaign(p_campaign_id) then
    raise exception 'You are not assigned to this campaign' using errcode = '42501';
  end if;
  return query
    select distinct k.phone_e164 from dialer_contacts k
    join dialer_campaigns c on c.id = p_campaign_id
    where k.airtable_client_id = c.airtable_client_id and k.phone_e164 = any(p_phones);
end $$;

-- Re-run: how many called contacts there are per last disposition, then copy the chosen ones into a new campaign.
-- Admins only. Do Not Call numbers (here or in any campaign) are never put back.
create or replace function public.dialer_rerun_counts(p_campaign_id uuid) returns table (disposition text, contacts int)
language sql stable security definer set search_path = public as $$
  select c.last_disposition, count(*)::int from dialer_contacts c
  where is_dialer_admin() and c.campaign_id = p_campaign_id and c.status in ('done', 'bad_number') and c.last_disposition is not null
    and not exists (select 1 from dialer_contacts d where d.phone_e164 = c.phone_e164 and d.status = 'do_not_call')
  group by c.last_disposition
  order by count(*) desc
$$;

-- Earlier versions: re-queue contacts in place, then copy them into an always-active campaign.
drop function if exists public.dialer_rerun_campaign(uuid, text[]);
drop function if exists public.dialer_rerun_as_new_campaign(uuid, text[], text);

-- Copies the chosen contacts (fresh, never called) into a new campaign (a draft, or launched as active) for the same
-- client, caller number and team. The original campaign is left as it is.
create or replace function public.dialer_rerun_campaign(p_campaign_id uuid, p_dispositions text[], p_name text, p_status text default 'draft')
returns table (campaign_id uuid, contacts int)
language plpgsql security definer set search_path = public as $$
declare
  src public.dialer_campaigns;
  new_id uuid;
  n int;
begin
  if not is_dialer_admin() then
    raise exception 'Only admins can re-run campaigns' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Give the new campaign a name' using errcode = 'P0001';
  end if;
  if p_status not in ('draft', 'active') then
    raise exception 'A new campaign starts as a draft or active' using errcode = 'P0001';
  end if;
  select * into src from dialer_campaigns where id = p_campaign_id;
  if src.id is null then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;

  insert into dialer_campaigns (name, client_name, airtable_client_id, caller_number_id, status, created_by)
  values (trim(p_name), src.client_name, src.airtable_client_id, src.caller_number_id, p_status, auth.uid())
  returning id into new_id;

  -- The team member (only one, even if the original has more from before that rule), plus any admins.
  insert into dialer_campaign_members (campaign_id, user_id)
  select new_id, m.user_id from dialer_campaign_members m join profiles p on p.id = m.user_id
  where m.campaign_id = p_campaign_id
    and (p.role::text <> 'team'
         or m.user_id = (select m2.user_id from dialer_campaign_members m2 join profiles p2 on p2.id = m2.user_id
                         where m2.campaign_id = p_campaign_id and p2.role::text = 'team'
                         order by coalesce(nullif(trim(p2.display_name), ''), p2.email) limit 1));

  insert into dialer_contacts (campaign_id, full_name, first_name, company, title, email, phone_e164, phone_raw, linkedin, website, custom, source)
  select new_id, c.full_name, c.first_name, c.company, c.title, c.email, c.phone_e164, c.phone_raw, c.linkedin, c.website, c.custom, c.source
  from dialer_contacts c
  where c.campaign_id = p_campaign_id and c.status in ('done', 'bad_number') and c.last_disposition = any(p_dispositions)
    and not exists (select 1 from dialer_contacts d where d.phone_e164 = c.phone_e164 and d.status = 'do_not_call')
  order by c.created_at;
  get diagnostics n = row_count;

  return query select new_id, n;
end $$;

-- Team list for admin screens and agent names.
drop function if exists public.dialer_users();
create function public.dialer_users() returns table (id uuid, email text, display_name text, role public.user_role, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.display_name, p.role, p.avatar_url from profiles p
  where p.role in ('team', 'admin') and is_dialer_user()
  order by coalesce(p.display_name, p.email)
$$;

-- Admins set a team member's profile picture (profiles is otherwise read-only to the app).
create or replace function public.dialer_set_avatar(p_user_id uuid, p_avatar text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_dialer_admin() then
    raise exception 'Only admins can change profile pictures' using errcode = '42501';
  end if;
  update profiles set avatar_url = nullif(trim(p_avatar), '') where id = p_user_id and role in ('team', 'admin');
end $$;
revoke execute on function public.dialer_set_avatar(uuid, text) from public, anon;
grant execute on function public.dialer_set_avatar(uuid, text) to authenticated, service_role;

-- Only signed-in users may call the dialer's functions (they also check the caller's role themselves).
revoke execute on function public.is_dialer_user(), public.is_dialer_admin(), public.dialer_can_access_campaign(uuid),
  public.dialer_claim_next_contact(uuid), public.dialer_claim_next(uuid, uuid), public.dialer_existing_phones(uuid, text[]), public.dialer_release_contact(uuid, boolean), public.dialer_users(),
  public.dialer_rerun_counts(uuid), public.dialer_rerun_campaign(uuid, text[], text, text),
  public.dialer_save_custom_fields(jsonb) from public, anon;
grant execute on function public.is_dialer_user(), public.is_dialer_admin(), public.dialer_can_access_campaign(uuid),
  public.dialer_claim_next_contact(uuid), public.dialer_claim_next(uuid, uuid), public.dialer_existing_phones(uuid, text[]), public.dialer_release_contact(uuid, boolean), public.dialer_users(),
  public.dialer_rerun_counts(uuid), public.dialer_rerun_campaign(uuid, text[], text, text),
  public.dialer_save_custom_fields(jsonb) to authenticated, service_role;

-- ── Stats ───────────────────────────────────────────────────────────────────────────────────────────────────
create or replace view public.dialer_campaign_stats with (security_invoker = true) as
with today as (select (date_trunc('day', now() at time zone 'Australia/Sydney') at time zone 'Australia/Sydney') as start)
select
  c.id as campaign_id,
  (select count(*) from dialer_contacts k where k.campaign_id = c.id)::int as contacts_total,
  (select count(*) from dialer_contacts k where k.campaign_id = c.id and k.status in ('new', 'callback'))::int as contacts_remaining,
  (select count(*) from dialer_calls x, today where x.campaign_id = c.id and x.direction = 'outbound' and x.started_at >= today.start)::int as dials_today,
  (select count(*) from dialer_calls x, today where x.campaign_id = c.id and x.direction = 'outbound' and x.started_at >= today.start and x.pickup_status = 'Human Pickup')::int as connects_today,
  (select count(*) from dialer_calls x where x.campaign_id = c.id and x.direction = 'outbound')::int as dials_total,
  (select count(*) from dialer_calls x where x.campaign_id = c.id and x.direction = 'outbound' and x.pickup_status = 'Human Pickup')::int as connects_total,
  -- For the booking rate (appointments ÷ dials). Added last so the view can be replaced in place.
  (select count(*) from dialer_calls x where x.campaign_id = c.id and x.direction = 'outbound' and x.disposition = 'Interested - Appointment Set')::int as appointments_total
from dialer_campaigns c;

-- Retry rules were removed: every call takes a contact out of the queue, and admins re-run by disposition.
alter table public.dialer_campaigns drop column if exists max_attempts, drop column if exists retry_after_minutes;
-- Contacts the old retry rules had scheduled for another try count as called; re-run brings them back. (Real
-- callbacks, booked with the Callback disposition, have a callback_user_id and are left alone.)
update public.dialer_contacts set status = 'done', next_attempt_at = null where status = 'callback' and callback_user_id is null;

-- Daily totals of the caller's own calls (optionally for one campaign or one client), for the Campaigns page
-- metrics. Admins see only their own here too; the team-wide view is dialer_performance_stats.
drop function if exists public.dialer_call_stats(timestamptz, timestamptz, uuid);
create or replace function public.dialer_call_stats(p_from timestamptz, p_to timestamptz, p_campaign_id uuid default null, p_client_name text default null)
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
    and (p_client_name is null or x.client_name = p_client_name)
    and x.user_id = auth.uid()
  group by 1, 2
  order by 1 desc
$$;

-- Totals per rep and client for a date range (optionally one client or campaign), for the admin Performance page.
-- Runs with the caller's access (RLS on calls applies: admins see every call).
create or replace function public.dialer_performance_stats(p_from timestamptz, p_to timestamptz, p_client_name text default null, p_campaign_id uuid default null)
returns table (user_id uuid, agent_name text, client_name text, dials int, connects int, machine int, unanswered int,
               appointments int, follow_ups int, talk_seconds int, last_call_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select x.user_id,
         max(x.agent_name) as agent_name,
         x.client_name,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as connects,
         count(*) filter (where x.pickup_status = 'Machine Pickup')::int as machine,
         count(*) filter (where x.pickup_status in ('Unanswered', 'Busy', 'Failed'))::int as unanswered,
         count(*) filter (where x.disposition = 'Interested - Appointment Set')::int as appointments,
         count(*) filter (where x.disposition = 'Interested - Needs Follow-Up')::int as follow_ups,
         coalesce(sum(x.duration_s) filter (where x.pickup_status = 'Human Pickup'), 0)::int as talk_seconds,
         max(x.started_at) as last_call_at
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer'
    and x.started_at >= p_from and x.started_at < p_to
    and (p_client_name is null or x.client_name = p_client_name)
    and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  group by x.user_id, x.client_name
$$;
revoke execute on function public.dialer_performance_stats(timestamptz, timestamptz, text, uuid) from public, anon;
grant execute on function public.dialer_performance_stats(timestamptz, timestamptz, text, uuid) to authenticated, service_role;

-- Admin Performance: each rep's dialing time, for calls per hour. Calls are grouped into sessions: a gap of more than
-- 15 minutes between one call ending and the next starting begins a new session. A session's time runs from its
-- first call to the end of its last, plus a minute for that last wrap-up. Admins only (others get no rows).
create or replace function public.dialer_rep_activity(p_from timestamptz, p_to timestamptz, p_client_name text default null, p_campaign_id uuid default null)
returns table (user_id uuid, dials int, sessions int, active_seconds int)
language sql stable security invoker set search_path = public as $$
  with calls as (
    select x.user_id, x.started_at,
           coalesce(x.ended_at, x.started_at + make_interval(secs => coalesce(x.duration_s, 0))) as ended_at
    from dialer_calls x
    where is_dialer_admin()
      and x.direction = 'outbound' and x.source = 'dialer' and x.user_id is not null
      and x.started_at >= p_from and x.started_at < p_to
      and (p_client_name is null or x.client_name = p_client_name)
      and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  ), marked as (
    select c.*,
           case when c.started_at - lag(c.ended_at) over (partition by c.user_id order by c.started_at) <= interval '15 minutes'
                then 0 else 1 end as new_session
    from calls c
  ), numbered as (
    select m.*, sum(m.new_session) over (partition by m.user_id order by m.started_at) as session
    from marked m
  ), per_session as (
    select n.user_id, n.session, count(*) as dials,
           extract(epoch from max(n.ended_at) - min(n.started_at)) + 60 as seconds
    from numbered n
    group by n.user_id, n.session
  )
  select s.user_id, sum(s.dials)::int, count(*)::int, round(sum(s.seconds))::int
  from per_session s
  group by s.user_id
$$;
revoke execute on function public.dialer_rep_activity(timestamptz, timestamptz, text, uuid) from public, anon;
grant execute on function public.dialer_rep_activity(timestamptz, timestamptz, text, uuid) to authenticated, service_role;

-- Admin Performance: dials and human pickups by weekday and hour (Sydney time), for the best times to call. Failed
-- calls never reached the phone network, so they're left out. Admins only.
create or replace function public.dialer_pickup_by_time(p_from timestamptz, p_to timestamptz, p_client_name text default null, p_campaign_id uuid default null)
returns table (dow int, hour int, dials int, human int)
language sql stable security invoker set search_path = public as $$
  select extract(isodow from x.started_at at time zone 'Australia/Sydney')::int as dow,
         extract(hour from x.started_at at time zone 'Australia/Sydney')::int as hour,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as human
  from dialer_calls x
  where is_dialer_admin()
    and x.direction = 'outbound' and x.source = 'dialer' and x.pickup_status is distinct from 'Failed'
    and x.started_at >= p_from and x.started_at < p_to
    and (p_client_name is null or x.client_name = p_client_name)
    and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  group by 1, 2
$$;
revoke execute on function public.dialer_pickup_by_time(timestamptz, timestamptz, text, uuid) from public, anon;
grant execute on function public.dialer_pickup_by_time(timestamptz, timestamptz, text, uuid) to authenticated, service_role;

-- Number health: dials from one of our numbers per day or week (Sydney time), and how many were answered by a
-- person, for spotting a number that's being flagged as spam (its human pickup rate drops). Failed calls never
-- reached the phone network, so they're left out. Runs with the caller's access (admins see every call).
create or replace function public.dialer_number_health(p_e164 text, p_bucket text default 'week', p_periods int default 12)
returns table (bucket date, dials int, answered int, human int)
language sql stable security invoker set search_path = public as $$
  select date_trunc(p_bucket, x.started_at at time zone 'Australia/Sydney')::date as bucket,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status in ('Human Pickup', 'Machine Pickup', 'Unclassified Pickup'))::int as answered,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as human
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer' and x.from_number = p_e164
    and x.pickup_status is distinct from 'Failed'
    and x.started_at >= (date_trunc(p_bucket, now() at time zone 'Australia/Sydney') - (p_periods - 1) * ('1 ' || p_bucket)::interval) at time zone 'Australia/Sydney'
  group by 1
  order by 1
$$;
revoke execute on function public.dialer_number_health(text, text, int) from public, anon;
grant execute on function public.dialer_number_health(text, text, int) to authenticated, service_role;

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
-- dialer-avatars: private; admins upload team profile pictures, anyone on the dialer team can view them.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dialer-avatars', 'dialer-avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
drop policy if exists "Dialer users view avatars" on storage.objects;
create policy "Dialer users view avatars" on storage.objects for select to authenticated
  using (bucket_id = 'dialer-avatars' and public.is_dialer_user());
drop policy if exists "Dialer admins manage avatars" on storage.objects;
create policy "Dialer admins manage avatars" on storage.objects for all to authenticated
  using (bucket_id = 'dialer-avatars' and public.is_dialer_admin())
  with check (bucket_id = 'dialer-avatars' and public.is_dialer_admin());

-- dialer-greetings: private; admins upload custom voicemail greetings.
insert into storage.buckets (id, name, public) values ('dialer-recordings', 'dialer-recordings', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('dialer-greetings', 'dialer-greetings', false) on conflict (id) do nothing;

drop policy if exists "Dialer admins manage greetings" on storage.objects;
create policy "Dialer admins manage greetings" on storage.objects for all to authenticated
  using (bucket_id = 'dialer-greetings' and public.is_dialer_admin())
  with check (bucket_id = 'dialer-greetings' and public.is_dialer_admin());

-- ── Call scripts ────────────────────────────────────────────────────────────────────────────────────────────
-- Per client (by Airtable client id); a campaign can pick one as its default. Bodies use {{variables}} (see
-- shared/script.ts). Admins write; reps read the scripts of clients whose campaigns they can open.
create table if not exists public.dialer_scripts (
  id uuid primary key default gen_random_uuid(),
  airtable_client_id text not null,
  client_name text not null,
  name text not null check (length(trim(name)) > 0),
  body text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dialer_scripts_client on public.dialer_scripts (airtable_client_id, name);
drop trigger if exists dialer_scripts_updated_at on public.dialer_scripts;
create trigger dialer_scripts_updated_at before update on public.dialer_scripts for each row execute function public.dialer_set_updated_at();

alter table public.dialer_scripts enable row level security;
drop policy if exists "Reps read their clients' scripts" on public.dialer_scripts;
create policy "Reps read their clients' scripts" on public.dialer_scripts for select to authenticated using (
  is_dialer_admin() or exists (
    select 1 from dialer_campaigns c where c.airtable_client_id = dialer_scripts.airtable_client_id and dialer_can_access_campaign(c.id)
  )
);
drop policy if exists "Admins manage scripts" on public.dialer_scripts;
create policy "Admins manage scripts" on public.dialer_scripts for all to authenticated using (is_dialer_admin()) with check (is_dialer_admin());

alter table public.dialer_campaigns add column if not exists script_id uuid references public.dialer_scripts(id) on delete set null;

-- ── Same-company heads-up ───────────────────────────────────────────────────────────────────────────────────
-- Company names and websites compared loosely: "Hunt St Pty Ltd" = "hunt st", "https://www.huntst.com/about" =
-- "huntst.com".
create or replace function public.dialer_company_key(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(regexp_replace(lower(coalesce(p, '')), '\m(pty|ltd|limited|inc|llc|co|group|holdings)\M', '', 'g'), '[^a-z0-9]', '', 'g'), '')
$$;
create or replace function public.dialer_domain_key(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(split_part(regexp_replace(lower(trim(coalesce(p, ''))), '^(https?://)?(www\.)?', ''), '/', 1), '')
$$;

-- For the contact about to be dialed: earlier calls where someone at the same company (same client, any campaign,
-- any rep) actually spoke to us, newest first, with that call's notes. The contact's own calls are left out (a
-- callback has its own panel). Security definer: reps only see their own calls otherwise.
create or replace function public.dialer_company_history(p_contact_id uuid)
returns table (started_at timestamptz, agent_name text, full_name text, title text, disposition text, notes text)
language plpgsql stable security definer set search_path = public as $$
declare
  k public.dialer_contacts;
begin
  select * into k from dialer_contacts where id = p_contact_id;
  if k.id is null or not dialer_can_access_campaign(k.campaign_id) then
    raise exception 'You are not assigned to this campaign' using errcode = '42501';
  end if;
  if dialer_company_key(k.company) is null and dialer_domain_key(k.website) is null then
    return;
  end if;
  return query
    select x.started_at, x.agent_name, coalesce(o.full_name, x.full_name), o.title, x.disposition, x.notes
    from dialer_calls x
    join dialer_contacts o on o.id = x.contact_id
    where x.pickup_status = 'Human Pickup'
      and x.source = 'dialer'
      and o.airtable_client_id = k.airtable_client_id
      and o.id <> k.id
      and o.phone_e164 <> k.phone_e164
      and (dialer_company_key(o.company) = dialer_company_key(k.company) or dialer_domain_key(o.website) = dialer_domain_key(k.website))
    order by x.started_at desc
    limit 5;
end $$;
revoke execute on function public.dialer_company_history(uuid) from public, anon;
grant execute on function public.dialer_company_history(uuid) to authenticated, service_role;

-- ── Click-to-call (one-off calls, e.g. from MaronlyOS's CRM) ───────────────────────────────────────────────────
-- The number one-off calls go out from (at most one; the default number is used if none is set).
alter table public.dialer_phone_numbers add column if not exists is_click_to_call boolean not null default false;
create unique index if not exists dialer_phone_numbers_one_click_to_call on public.dialer_phone_numbers (is_click_to_call) where is_click_to_call;

-- Logs a one-off call to any AU/NZ number (checked by the server) with no campaign or contact. Admins only for now.
-- Returns the caller number and the number to call, or {error}.
create or replace function public.dialer_start_oneoff_call(p_call_id uuid, p_user_id uuid, p_to text, p_name text, p_company text,
                                                         p_client_name text, p_twilio_call_sid text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  prof public.profiles;
  caller text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Only the server can start calls' using errcode = '42501';
  end if;
  select * into prof from profiles where id = p_user_id;
  if prof.id is null or prof.role::text <> 'admin' then
    return jsonb_build_object('error', 'user');
  end if;
  caller := coalesce(
    (select e164 from dialer_phone_numbers where is_click_to_call limit 1),
    (select e164 from dialer_phone_numbers where is_default order by created_at limit 1)
  );
  insert into dialer_calls (id, direction, user_id, agent_name, client_name, campaign_name, full_name, company, phone_e164, from_number,
                            to_number, twilio_call_sid, twilio_status)
  values (p_call_id, 'outbound', p_user_id, coalesce(nullif(trim(prof.display_name), ''), prof.email), nullif(trim(p_client_name), ''),
          'Click-to-call', nullif(trim(p_name), ''), nullif(trim(p_company), ''), p_to, caller, p_to, p_twilio_call_sid,
          case when caller is null then 'failed' else 'initiated' end)
  on conflict (id) do nothing;
  return jsonb_build_object('from', caller, 'to', p_to);
end $$;
revoke execute on function public.dialer_start_oneoff_call(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.dialer_start_oneoff_call(uuid, uuid, text, text, text, text, text) to service_role;

