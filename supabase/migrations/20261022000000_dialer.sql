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
  'Interested - Appointment Set', 'Interested - Needs Follow-Up', 'Referral', 'Callback', 'Not Interested', 'Left Voicemail', 'No Answer',
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

  -- Rotates across the campaign's numbers, with new numbers' warm-up caps (dialer_pick_caller, defined further down).
  caller := dialer_pick_caller(camp.id, c.phone_e164);

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
  insert into dialer_campaign_numbers (campaign_id, number_id)
  select new_id, cn.number_id from dialer_campaign_numbers cn where cn.campaign_id = p_campaign_id;

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
  (select count(*) from dialer_calls x where x.campaign_id = c.id and x.direction = 'outbound' and x.disposition = 'Interested - Appointment Set')::int as appointments_total,
  -- Contacts not called yet (evergreen campaigns: the rep's "waiting" dot). Added last, as above.
  (select count(*) from dialer_contacts k where k.campaign_id = c.id and k.status = 'new')::int as contacts_new,
  -- Skipped by a rep: count towards completion, shown in yellow on the progress bar. Added last, as above.
  (select count(*) from dialer_contacts k where k.campaign_id = c.id and k.status = 'skipped')::int as contacts_skipped
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
         count(*) filter (where x.disposition in ('Interested - Needs Follow-Up', 'Referral'))::int as follow_ups,
         coalesce(sum(x.duration_s) filter (where x.pickup_status = 'Human Pickup'), 0)::int as talk_seconds
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer' and x.campaign_id is not null
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
         count(*) filter (where x.disposition in ('Interested - Needs Follow-Up', 'Referral'))::int as follow_ups,
         coalesce(sum(x.duration_s) filter (where x.pickup_status = 'Human Pickup'), 0)::int as talk_seconds,
         max(x.started_at) as last_call_at
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer' and x.campaign_id is not null
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
      and x.direction = 'outbound' and x.source = 'dialer' and x.campaign_id is not null and x.user_id is not null
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
    (select e164 from dialer_phone_numbers where is_click_to_call limit 1)
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

-- When someone copied a share link for this call's recording (Call logs). /r/{callId}.mp3 then plays it without a
-- login, like lead recordings; null = not shared.
alter table public.dialer_calls add column if not exists recording_shared_at timestamptz;


-- ── Google Calendar (per client: the host's calendar, for meeting invites) ─────────────────────────────────────
-- One row per Airtable client. The host (e.g. the founder) connects their own Google Calendar from a link an admin
-- sends them (OAuth, scopes calendar.freebusy + calendar.events.owned). Settings are readable by reps of that
-- client's campaigns; connection fields are written by the server only.
create table if not exists public.dialer_client_calendars (
  airtable_client_id text primary key,
  client_name text not null default '',
  invites_enabled boolean not null default false,
  meeting_minutes integer not null default 30 check (meeting_minutes between 5 and 240),
  title_template text not null default '{{client}} × {{company}}',
  description_template text not null default '',
  google_email text,
  status text not null default 'not_connected' check (status in ('not_connected', 'connected', 'disconnected')),
  connected_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
drop trigger if exists dialer_client_calendars_updated_at on public.dialer_client_calendars;
create trigger dialer_client_calendars_updated_at before update on public.dialer_client_calendars for each row execute function public.dialer_set_updated_at();

alter table public.dialer_client_calendars enable row level security;
drop policy if exists "Reps read their clients' calendar settings" on public.dialer_client_calendars;
create policy "Reps read their clients' calendar settings" on public.dialer_client_calendars for select to authenticated using (
  is_dialer_admin() or exists (
    select 1 from dialer_campaigns c where c.airtable_client_id = dialer_client_calendars.airtable_client_id and dialer_can_access_campaign(c.id)
  )
);
drop policy if exists "Admins edit calendar settings" on public.dialer_client_calendars;
create policy "Admins edit calendar settings" on public.dialer_client_calendars for update to authenticated using (is_dialer_admin()) with check (is_dialer_admin());
drop policy if exists "Admins add calendar settings" on public.dialer_client_calendars;
create policy "Admins add calendar settings" on public.dialer_client_calendars for insert to authenticated with check (is_dialer_admin());

-- The host's Google refresh token, encrypted (AES-256-GCM, key in Netlify). No policies: server (service role) only.
create table if not exists public.dialer_calendar_tokens (
  airtable_client_id text primary key references public.dialer_client_calendars(airtable_client_id) on delete cascade,
  refresh_token_enc text not null,
  scopes text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.dialer_calendar_tokens enable row level security;

-- ── Campaign period labels ──────────────────────────────────────────────────────────────────────────────────────
-- The half-month (1st–14th = 1, 15th–end = 2, Sydney time) in which most of each campaign's dials were made, for the
-- "(November 1/2)" label on the Campaigns tab. Counts every rep's dials; callers only get campaigns they can open.
create or replace function public.dialer_campaign_periods()
returns table (campaign_id uuid, period_month date, half int, dials int)
language sql stable security definer set search_path = public as $$
  select distinct on (s.campaign_id) s.campaign_id, s.m, s.h, s.n
  from (
    select x.campaign_id,
           date_trunc('month', x.started_at at time zone 'Australia/Sydney')::date as m,
           case when extract(day from x.started_at at time zone 'Australia/Sydney') < 15 then 1 else 2 end as h,
           count(*)::int as n
    from dialer_calls x
    where x.direction = 'outbound' and x.campaign_id is not null
      and dialer_can_access_campaign(x.campaign_id)
    group by 1, 2, 3
  ) s
  order by s.campaign_id, s.n desc, s.m desc, s.h desc
$$;
revoke execute on function public.dialer_campaign_periods() from public, anon;
grant execute on function public.dialer_campaign_periods() to authenticated, service_role;

-- ── Old JustCall campaigns ──────────────────────────────────────────────────────────────────────────────────────
-- 'justcall' campaigns were rebuilt from the imported JustCall calls (one per Sales Dialer campaign name, status
-- completed, the reps who dialled them as members). They have no contacts; the app shows a JustCall label and opens
-- their calls in Call logs. Performance and other stats count source = 'dialer' calls only.
alter table public.dialer_campaigns add column if not exists source text not null default 'dialer';
alter table public.dialer_campaigns drop constraint if exists dialer_campaigns_source_check;
alter table public.dialer_campaigns add constraint dialer_campaigns_source_check check (source in ('dialer', 'justcall'));

-- ── Client logos ────────────────────────────────────────────────────────────────────────────────────────────────
-- Copies of each client's Airtable logo (Clients → Client Logo Image) in a public bucket, so the app loads them from a
-- fixed, long-cached address instead of Airtable's expiring links. Kept in sync by the sweep; logos aren't sensitive.
create table if not exists public.dialer_client_logos (
  airtable_client_id text primary key,
  attachment_id text not null,
  url text not null,
  updated_at timestamptz not null default now()
);
alter table public.dialer_client_logos enable row level security;
drop policy if exists "Dialer users read client logos" on public.dialer_client_logos;
create policy "Dialer users read client logos" on public.dialer_client_logos for select to authenticated using (is_dialer_user());
insert into storage.buckets (id, name, public) values ('client-logos', 'client-logos', true) on conflict (id) do nothing;

-- ── Number reputation alert ─────────────────────────────────────────────────────────────────────────────────────
-- Per number: human pickups over its last 80 dials (failed calls left out) and over the 400 before that, its own
-- baseline. The app (shared/numberHealth.ts) flags a number whose recent rate has dropped well below its baseline,
-- a sign it's being labelled as spam. Each client has its own number and audiences differ, so a number is only ever
-- compared with itself. Admins only.
create or replace function public.dialer_number_reputation()
returns table (number_id uuid, recent_dials int, recent_human int, baseline_dials int, baseline_human int, last_dial_at timestamptz)
language sql stable security invoker set search_path = public as $$
  with c as (
    select n.id, x.started_at, x.pickup_status = 'Human Pickup' as human,
           row_number() over (partition by n.id order by x.started_at desc) as rn
    from dialer_phone_numbers n
    join dialer_calls x on x.from_number = n.e164
    where is_dialer_admin()
      and x.source = 'dialer' and x.direction = 'outbound' and x.kind = 'call'
      and x.pickup_status is distinct from 'Failed'
  )
  select id,
         count(*) filter (where rn <= 80)::int,
         count(*) filter (where rn <= 80 and human)::int,
         count(*) filter (where rn > 80 and rn <= 480)::int,
         count(*) filter (where rn > 80 and rn <= 480 and human)::int,
         max(started_at)
  from c group by id
$$;
revoke execute on function public.dialer_number_reputation() from public, anon;
grant execute on function public.dialer_number_reputation() to authenticated, service_role;

-- ── No default number ───────────────────────────────────────────────────────────────────────────────────────────
-- Calls go out from the campaign's chosen number or its client's number (one-off calls: the click-to-call number);
-- there's no account-wide fallback. Campaigns can't be saved without one (Campaigns → create/edit).
-- After the app stops using it, the column is dropped by hand: alter table public.dialer_phone_numbers drop column is_default;
-- Custom voicemail greetings were removed (callers always hear the standard message). Once the app no longer reads
-- it, the column can be dropped by hand: alter table public.dialer_phone_numbers drop column voicemail_greeting_path;

-- ── Evergreen campaigns (warm leads clients submit in the portal) ───────────────────────────────────────────────
-- One evergreen campaign per client, made by an admin. The portal only offers "submit a lead" when the client has one.
-- Leads arrive from Clay (after phone enrichment) via POST /api/inbound/lead and are added to it with the client's
-- context, which the rep sees while dialling. The portal submission id is kept in custom.portal_submission_id.
alter table public.dialer_campaigns add column if not exists is_evergreen boolean not null default false;
create unique index if not exists dialer_campaigns_one_evergreen_per_client on public.dialer_campaigns (airtable_client_id) where is_evergreen;
alter table public.dialer_contacts add column if not exists context text;

-- ── Why a call failed ───────────────────────────────────────────────────────────────────────────────────────────
-- From Twilio's status webhook for failed/busy calls, so the dialer can say "this number isn't connected" (error
-- 13224 / SIP 404) instead of the browser's generic connection error, and suggest Disconnected Number.
alter table public.dialer_calls add column if not exists twilio_error_code int;
alter table public.dialer_calls add column if not exists sip_response_code int;

-- ── Performance trend ───────────────────────────────────────────────────────────────────────────────────────────
-- Admin Performance chart: dials, human answers, leads (both Interested dispositions) and meetings booked per hour,
-- day, week (Mon) or month, Sydney time, for the page's date range, client and campaign filters. Bucket keys are
-- 'YYYY-MM-DD' (week and month: their first day) or 'YYYY-MM-DD HH24' for hours. RLS limits rows to what the caller
-- can see, like dialer_performance_stats.
create or replace function public.dialer_performance_trend(p_from timestamptz, p_to timestamptz, p_bucket text,
                                                           p_client_name text default null, p_campaign_id uuid default null)
returns table (bucket text, dials int, connects int, leads int, appointments int)
language sql stable security invoker set search_path = public as $$
  select case p_bucket
           when 'hour' then to_char(x.started_at at time zone 'Australia/Sydney', 'YYYY-MM-DD HH24')
           when 'week' then to_char(date_trunc('week', x.started_at at time zone 'Australia/Sydney'), 'YYYY-MM-DD')
           when 'month' then to_char(date_trunc('month', x.started_at at time zone 'Australia/Sydney'), 'YYYY-MM-DD')
           else to_char(x.started_at at time zone 'Australia/Sydney', 'YYYY-MM-DD')
         end as bucket,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as connects,
         count(*) filter (where x.disposition in ('Interested - Needs Follow-Up', 'Interested - Appointment Set'))::int as leads,
         count(*) filter (where x.disposition = 'Interested - Appointment Set')::int as appointments
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer'
    and x.started_at >= p_from and x.started_at < p_to
    and (p_client_name is null or x.client_name = p_client_name)
    and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  group by 1
  order by 1
$$;
revoke execute on function public.dialer_performance_trend(timestamptz, timestamptz, text, text, uuid) from public, anon;
grant execute on function public.dialer_performance_trend(timestamptz, timestamptz, text, text, uuid) to authenticated, service_role;

-- ── Pickups through a session ───────────────────────────────────────────────────────────────────────────────────
-- Admin Performance, "Best times to call" → Session: human pickup rate in the first, middle and last third of each
-- rep's longer dialing sessions (p_min_dials+ calls), to see whether pickups fade or dip as a session goes on.
-- Sessions are grouped like dialer_rep_activity: a gap of more than 15 minutes starts a new one. Built from the calls
-- in the filters; failed calls count towards a session's length and position but not the rate. Admins only.
create or replace function public.dialer_pickup_by_session_part(p_from timestamptz, p_to timestamptz, p_client_name text default null,
                                                                p_campaign_id uuid default null, p_min_dials int default 30)
returns table (part int, dials int, human int, sessions int)
language sql stable security invoker set search_path = public as $$
  with calls as (
    select x.user_id, x.started_at, x.pickup_status,
           coalesce(x.ended_at, x.started_at + make_interval(secs => coalesce(x.duration_s, 0))) as ended_at
    from dialer_calls x
    where is_dialer_admin()
      and x.direction = 'outbound' and x.source = 'dialer' and x.kind = 'call' and x.user_id is not null
      and x.started_at >= p_from and x.started_at < p_to
      and (p_client_name is null or x.client_name = p_client_name)
      and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  ), marked as (
    select c.*,
           case when c.started_at - lag(c.ended_at) over (partition by c.user_id order by c.started_at) <= interval '15 minutes'
                then 0 else 1 end as new_session
    from calls c
  ), numbered as (
    select m.*, sum(m.new_session) over (partition by m.user_id order by m.started_at) as session_no from marked m
  ), placed as (
    select n.*, row_number() over (partition by n.user_id, n.session_no order by n.started_at) as pos,
           count(*) over (partition by n.user_id, n.session_no) as len
    from numbered n
  )
  select least(3, 1 + floor(3.0 * (pos - 1) / len))::int as part,
         count(*) filter (where pickup_status is distinct from 'Failed')::int as dials,
         count(*) filter (where pickup_status = 'Human Pickup')::int as human,
         count(distinct (user_id, session_no))::int as sessions
  from placed
  where len >= p_min_dials
  group by 1
  order by 1
$$;
revoke execute on function public.dialer_pickup_by_session_part(timestamptz, timestamptz, text, uuid, int) from public, anon;
grant execute on function public.dialer_pickup_by_session_part(timestamptz, timestamptz, text, uuid, int) to authenticated, service_role;

-- Each of those sessions on its own, newest first, so an admin can pick one rep's session and follow its pickup rate
-- from start to finish (the dialer then loads that session's calls). Includes each session's thirds, so the summary
-- for one rep is a sum. Same session rules and filters as dialer_pickup_by_session_part. Admins only.
create or replace function public.dialer_dialing_sessions(p_from timestamptz, p_to timestamptz, p_client_name text default null,
                                                          p_campaign_id uuid default null, p_min_dials int default 30)
returns table (user_id uuid, agent_name text, started_at timestamptz, ended_at timestamptz, dials int, rated int, human int,
               client_names text, from_numbers text,
               t1_dials int, t1_human int, t2_dials int, t2_human int, t3_dials int, t3_human int)
language sql stable security invoker set search_path = public as $$
  with calls as (
    select x.user_id, x.agent_name, x.client_name, x.from_number, x.started_at, x.pickup_status,
           coalesce(x.ended_at, x.started_at + make_interval(secs => coalesce(x.duration_s, 0))) as ended_at
    from dialer_calls x
    where is_dialer_admin()
      and x.direction = 'outbound' and x.source = 'dialer' and x.kind = 'call' and x.user_id is not null
      and x.started_at >= p_from and x.started_at < p_to
      and (p_client_name is null or x.client_name = p_client_name)
      and (p_campaign_id is null or x.campaign_id = p_campaign_id)
  ), marked as (
    select c.*,
           case when c.started_at - lag(c.ended_at) over (partition by c.user_id order by c.started_at) <= interval '15 minutes'
                then 0 else 1 end as new_session
    from calls c
  ), numbered as (
    select m.*, sum(m.new_session) over (partition by m.user_id order by m.started_at) as session_no from marked m
  ), placed as (
    select n.*, row_number() over (partition by n.user_id, n.session_no order by n.started_at) as pos,
           count(*) over (partition by n.user_id, n.session_no) as len,
           n.pickup_status is distinct from 'Failed' as rated,
           n.pickup_status = 'Human Pickup' as is_human
    from numbered n
  ), parted as (
    select p.*, least(3, 1 + floor(3.0 * (p.pos - 1) / p.len))::int as part from placed p where p.len >= p_min_dials
  )
  select user_id, max(agent_name), min(started_at), max(ended_at),
         count(*)::int, count(*) filter (where rated)::int, count(*) filter (where is_human)::int,
         string_agg(distinct client_name, ', '), string_agg(distinct from_number, ', '),
         count(*) filter (where rated and part = 1)::int, count(*) filter (where is_human and part = 1)::int,
         count(*) filter (where rated and part = 2)::int, count(*) filter (where is_human and part = 2)::int,
         count(*) filter (where rated and part = 3)::int, count(*) filter (where is_human and part = 3)::int
  from parted
  group by user_id, session_no
  order by min(started_at) desc
$$;
revoke execute on function public.dialer_dialing_sessions(timestamptz, timestamptz, text, uuid, int) from public, anon;
grant execute on function public.dialer_dialing_sessions(timestamptz, timestamptz, text, uuid, int) to authenticated, service_role;

-- ── Performance by team member ──────────────────────────────────────────────────────────────────────────────────
-- The Performance page filters by date, client and team member (no campaign filter: a campaign's page has its own
-- metrics). These replace dialer_performance_trend and dialer_pickup_by_time, which are dropped below along with the
-- session-view functions the page no longer has.
create or replace function public.dialer_activity_trend(p_from timestamptz, p_to timestamptz, p_bucket text,
                                                        p_client_name text default null, p_user_id uuid default null)
returns table (bucket text, dials int, connects int, leads int, appointments int)
language sql stable security invoker set search_path = public as $$
  select case p_bucket
           when 'hour' then to_char(x.started_at at time zone 'Australia/Sydney', 'YYYY-MM-DD HH24')
           when 'week' then to_char(date_trunc('week', x.started_at at time zone 'Australia/Sydney'), 'YYYY-MM-DD')
           when 'month' then to_char(date_trunc('month', x.started_at at time zone 'Australia/Sydney'), 'YYYY-MM-DD')
           else to_char(x.started_at at time zone 'Australia/Sydney', 'YYYY-MM-DD')
         end as bucket,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as connects,
         count(*) filter (where x.disposition in ('Interested - Needs Follow-Up', 'Interested - Appointment Set', 'Referral'))::int as leads,
         count(*) filter (where x.disposition = 'Interested - Appointment Set')::int as appointments
  from dialer_calls x
  where x.direction = 'outbound' and x.source = 'dialer' and x.campaign_id is not null
    and x.started_at >= p_from and x.started_at < p_to
    and (p_client_name is null or x.client_name = p_client_name)
    and (p_user_id is null or x.user_id = p_user_id)
  group by 1
  order by 1
$$;
revoke execute on function public.dialer_activity_trend(timestamptz, timestamptz, text, text, uuid) from public, anon;
grant execute on function public.dialer_activity_trend(timestamptz, timestamptz, text, text, uuid) to authenticated, service_role;

create or replace function public.dialer_pickup_times(p_from timestamptz, p_to timestamptz, p_client_name text default null, p_user_id uuid default null)
returns table (dow int, hour int, dials int, human int)
language sql stable security invoker set search_path = public as $$
  select extract(isodow from x.started_at at time zone 'Australia/Sydney')::int as dow,
         extract(hour from x.started_at at time zone 'Australia/Sydney')::int as hour,
         count(*)::int as dials,
         count(*) filter (where x.pickup_status = 'Human Pickup')::int as human
  from dialer_calls x
  where is_dialer_admin()
    and x.direction = 'outbound' and x.source = 'dialer' and x.campaign_id is not null and x.pickup_status is distinct from 'Failed'
    and x.started_at >= p_from and x.started_at < p_to
    and (p_client_name is null or x.client_name = p_client_name)
    and (p_user_id is null or x.user_id = p_user_id)
  group by 1, 2
$$;
revoke execute on function public.dialer_pickup_times(timestamptz, timestamptz, text, uuid) from public, anon;
grant execute on function public.dialer_pickup_times(timestamptz, timestamptz, text, uuid) to authenticated, service_role;

drop function if exists public.dialer_performance_trend(timestamptz, timestamptz, text, text, uuid);
drop function if exists public.dialer_pickup_by_time(timestamptz, timestamptz, text, uuid);
drop function if exists public.dialer_pickup_by_session_part(timestamptz, timestamptz, text, uuid, int);
drop function if exists public.dialer_dialing_sessions(timestamptz, timestamptz, text, uuid, int);

-- ── Call audio from the rep's browser ───────────────────────────────────────────────────────────────────────────
-- For diagnosing "connected but I can't hear them": ms from the answer until the rep first heard the prospect
-- (heard_ms) and first spoke (spoke_ms), Twilio's quality warnings, the mic and speaker in use, browser and edge.
-- Written by POST /api/call-audio when an answered call ends.
alter table public.dialer_calls add column if not exists client_audio jsonb;

-- Referral disposition (21 Nov 2026): the person called referred us to someone else. The dialer makes two linked
-- Airtable leads, the parent (the person called) in airtable_lead_id and the sublead (the person referred) here, so a
-- retry or an edit never makes the sublead twice. Referrals count as leads in the stats (disposition list above and
-- dialer_call_stats / dialer_performance_stats / dialer_activity_trend updated in place).
alter table public.dialer_calls add column if not exists airtable_sublead_id text;

-- AI call insights (21 Nov 2026). Admin-only, always: reps never see these tables. An admin runs the analysis from a
-- campaign; each human pickup with a transcript gets one row (a summary, what went well, what hurt the chance of a
-- booking), made once, using the client's context pack from MaronlyOS (dialer_client_context_packs). Later "AI campaign
-- insights" will read this table.
create table if not exists public.dialer_ai_call_insights (
  call_id uuid primary key references public.dialer_calls(id) on delete cascade,
  summary text not null,
  positives text not null default '',
  negatives text not null default '',
  -- Which model and which version of the client's context pack produced it.
  model text not null,
  context_version text,
  created_at timestamptz not null default now()
);
alter table public.dialer_ai_call_insights enable row level security;
drop policy if exists dialer_ai_call_insights_admin_read on public.dialer_ai_call_insights;
create policy dialer_ai_call_insights_admin_read on public.dialer_ai_call_insights for select to authenticated using (public.is_dialer_admin());

-- The latest analysis run per campaign: progress for the admin's screen and a guard against two runs at once. Only the
-- server reads and writes it (no policies).
create table if not exists public.dialer_ai_insight_runs (
  campaign_id uuid primary key references public.dialer_campaigns(id) on delete cascade,
  started_by uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  total int not null default 0,
  done int not null default 0,
  failed int not null default 0,
  error text
);
alter table public.dialer_ai_insight_runs enable row level security;

-- A campaign's human pickups: whether each has a transcript yet and whether it's been analysed. Server only.
create or replace function public.dialer_ai_insight_queue(p_campaign_id uuid)
returns table (call_id uuid, has_transcript boolean, analysed boolean)
language sql stable security definer set search_path = public as $$
  select c.id,
         (c.transcript is not null or c.transcript_json is not null),
         exists (select 1 from dialer_ai_call_insights i where i.call_id = c.id)
  from dialer_calls c
  where c.campaign_id = p_campaign_id and c.direction = 'outbound' and c.pickup_status = 'Human Pickup'
  order by c.started_at
$$;
revoke execute on function public.dialer_ai_insight_queue(uuid) from public, anon, authenticated;
grant execute on function public.dialer_ai_insight_queue(uuid) to service_role;

-- Starts a run unless one is already going (a run that hasn't finished within 16 minutes is treated as dead: the
-- background job stops itself before then). Returns whether this call started it. Server only.
create or replace function public.dialer_ai_insight_start_run(p_campaign_id uuid, p_user_id uuid, p_total int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into dialer_ai_insight_runs as r (campaign_id, started_by, started_at, finished_at, total, done, failed, error)
  values (p_campaign_id, p_user_id, now(), null, p_total, 0, 0, null)
  on conflict (campaign_id) do update
    set started_by = excluded.started_by, started_at = now(), finished_at = null, total = excluded.total, done = 0, failed = 0, error = null
    where r.finished_at is not null or r.started_at < now() - interval '16 minutes';
  return found;
end $$;
revoke execute on function public.dialer_ai_insight_start_run(uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.dialer_ai_insight_start_run(uuid, uuid, int) to service_role;

-- A campaign's Clay table, for analysis (21 Nov 2026). Admin-only like the rest of the AI insights: only the server
-- reads and writes it (no policies). Running a campaign never needs it; the analysis does, together with the client's
-- context. The check reads the table through Clay's Public API and counts how many of the campaign's contacts it finds
-- (by LinkedIn profile, else first name + company domain). Several campaigns can point at the same table.
create table if not exists public.dialer_campaign_clay (
  campaign_id uuid primary key references public.dialer_campaigns(id) on delete cascade,
  table_id text not null,
  table_url text not null,
  -- Result of the latest check.
  checked_at timestamptz not null default now(),
  checked_by uuid,
  rows_read int not null default 0,
  table_complete boolean not null default true,
  contacts_total int not null default 0,
  contacts_matched int not null default 0,
  columns jsonb not null default '[]'
);
alter table public.dialer_campaign_clay enable row level security;

-- Several caller numbers per campaign, rotated on every dial, with a warm-up for new numbers (21 Nov 2026).
-- dialer_campaigns.caller_number_id is kept (set to the first chosen number) for older code; calls use this table.
create table if not exists public.dialer_campaign_numbers (
  campaign_id uuid not null references public.dialer_campaigns(id) on delete cascade,
  number_id uuid not null references public.dialer_phone_numbers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, number_id)
);
alter table public.dialer_campaign_numbers enable row level security;
drop policy if exists dialer_campaign_numbers_read on public.dialer_campaign_numbers;
create policy dialer_campaign_numbers_read on public.dialer_campaign_numbers for select to authenticated using (public.dialer_can_access_campaign(campaign_id));
drop policy if exists dialer_campaign_numbers_admin on public.dialer_campaign_numbers;
create policy dialer_campaign_numbers_admin on public.dialer_campaign_numbers for all to authenticated using (public.is_dialer_admin()) with check (public.is_dialer_admin());
insert into public.dialer_campaign_numbers (campaign_id, number_id)
select id, caller_number_id from public.dialer_campaigns where caller_number_id is not null
on conflict do nothing;
create index if not exists dialer_calls_from_number on public.dialer_calls (from_number, started_at);

-- Warm-up: how many calls a number may make on day N of dialling (day 1 = the first Sydney day it dialled). Null =
-- warmed up (no cap). Rule-of-thumb ramp to keep new numbers from being flagged as spam by carriers and caller-ID apps.
create or replace function public.dialer_warmup_cap(p_day int) returns int language sql immutable as $$
  select case when p_day <= 7 then 30 when p_day <= 14 then 60 when p_day <= 21 then 100 else null end
$$;

-- Each number's warm-up day, today's dials and today's cap. Admins and the server only (others get no rows).
create or replace function public.dialer_number_usage(p_ids uuid[] default null)
returns table (number_id uuid, e164 text, created_at timestamptz, first_dial_day date, warmup_day int, dials_today int, daily_cap int)
language sql stable security definer set search_path = public as $$
  with today as (select (now() at time zone 'Australia/Sydney')::date as d)
  select n.id, n.e164, n.created_at, f.first_day,
         coalesce(t.d - f.first_day + 1, 1),
         (select count(*) from dialer_calls c
          where c.from_number = n.e164 and c.direction = 'outbound' and c.started_at >= (t.d::timestamp at time zone 'Australia/Sydney'))::int,
         dialer_warmup_cap(coalesce(t.d - f.first_day + 1, 1))
  from dialer_phone_numbers n
  cross join today t
  left join lateral (
    select (min(c.started_at) at time zone 'Australia/Sydney')::date as first_day
    from dialer_calls c where c.from_number = n.e164 and c.direction = 'outbound'
  ) f on true
  where (p_ids is null or n.id = any(p_ids))
    and (is_dialer_admin() or coalesce(auth.role(), '') = 'service_role')
$$;

-- The number to dial this person from, out of the campaign's numbers (or, if it has none, its client's oldest):
-- 1. the number they were last called from, so they recognise it, unless that number is at its warm-up cap;
-- 2. otherwise the least used today relative to its cap (warmed-up numbers count against 150 a day, for balance),
--    so every dial rotates and a new number's calls spread across the day;
-- 3. if every number is at its cap, the oldest one: reps are never blocked.
create or replace function public.dialer_pick_caller(p_campaign_id uuid, p_to text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  ids uuid[];
  picked text;
begin
  select array_agg(number_id) into ids from dialer_campaign_numbers where campaign_id = p_campaign_id;
  if ids is null then
    select array_agg(id) into ids from (
      select n.id from dialer_phone_numbers n join dialer_campaigns c on c.client_name = n.client_name
      where c.id = p_campaign_id order by n.created_at limit 1) x;
  end if;
  if ids is null then return null; end if;

  with u as (select * from dialer_number_usage(ids))
  select u.e164 into picked from u
  where u.e164 = (select c.from_number from dialer_calls c
                  where c.to_number = p_to and c.direction = 'outbound' and c.from_number in (select e164 from u)
                  order by c.started_at desc limit 1)
    and (u.daily_cap is null or u.dials_today < u.daily_cap);
  if picked is not null then return picked; end if;

  with u as (select * from dialer_number_usage(ids))
  select u.e164 into picked from u
  where u.daily_cap is null or u.dials_today < u.daily_cap
  order by u.dials_today::numeric / coalesce(u.daily_cap, 150), u.first_dial_day nulls last, u.created_at
  limit 1;
  if picked is not null then return picked; end if;

  with u as (select * from dialer_number_usage(ids))
  select u.e164 into picked from u order by u.first_dial_day nulls last, u.created_at limit 1;
  return picked;
end $$;
revoke execute on function public.dialer_pick_caller(uuid, text) from public, anon, authenticated;
grant execute on function public.dialer_pick_caller(uuid, text) to service_role;

-- Job title of the person called, for calls with no contact record (imported JustCall history). Dialer calls read it from dialer_contacts.
alter table public.dialer_calls add column if not exists title text;

-- ── Skipped contacts ─────────────────────────────────────────────────────────────────────────────────────
-- A rep's Skip takes the contact out of the queue as 'skipped' (who and when kept), so it counts towards the
-- campaign being complete. Skipping a callback still only puts it back in the queue: callbacks are promised.
alter table public.dialer_contacts drop constraint if exists dialer_contacts_status_check;
alter table public.dialer_contacts add constraint dialer_contacts_status_check
  check (status in ('new', 'callback', 'done', 'do_not_call', 'bad_number', 'skipped'));
alter table public.dialer_contacts add column if not exists skipped_at timestamptz, add column if not exists skipped_by uuid;

create or replace function public.dialer_release_contact(p_contact_id uuid, p_skip boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  update dialer_contacts c
  set locked_by = null,
      locked_at = null,
      status = case when p_skip and c.status = 'new' then 'skipped' else c.status end,
      skipped_at = case when p_skip and c.status = 'new' then now() else c.skipped_at end,
      skipped_by = case when p_skip and c.status = 'new' then auth.uid() else c.skipped_by end,
      next_attempt_at = case when p_skip and c.status = 'callback' then now() else c.next_attempt_at end
  where c.id = p_contact_id and c.locked_by = auth.uid();
end $$;

-- Re-run offers skipped contacts as their own row ("Skipped"), alongside the last dispositions.
create or replace function public.dialer_rerun_counts(p_campaign_id uuid) returns table (disposition text, contacts int)
language sql stable security definer set search_path = public as $$
  select d, count(*)::int from (
    select case when c.status = 'skipped' then 'Skipped' else c.last_disposition end as d
    from dialer_contacts c
    where is_dialer_admin() and c.campaign_id = p_campaign_id
      and (c.status = 'skipped' or (c.status in ('done', 'bad_number') and c.last_disposition is not null))
      and not exists (select 1 from dialer_contacts k where k.phone_e164 = c.phone_e164 and k.status = 'do_not_call')
  ) x
  group by d
  order by count(*) desc
$$;

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
  insert into dialer_campaign_numbers (campaign_id, number_id)
  select new_id, cn.number_id from dialer_campaign_numbers cn where cn.campaign_id = p_campaign_id;

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
  where c.campaign_id = p_campaign_id
    and ((c.status in ('done', 'bad_number') and c.last_disposition = any(p_dispositions))
         or (c.status = 'skipped' and 'Skipped' = any(p_dispositions)))
    and not exists (select 1 from dialer_contacts d where d.phone_e164 = c.phone_e164 and d.status = 'do_not_call')
  order by c.created_at;
  get diagnostics n = row_count;

  return query select new_id, n;
end $$;


-- ── Row security, evaluated once per query ──────────────────────────────────────────────────────────────
-- The role checks are wrapped in (select …) so Postgres runs them once per query instead of once per row (the advice
-- in Supabase's RLS performance guide); admins skip the per-row campaign check. Same rules as before.
drop policy if exists "dialer_ai_call_insights_admin_read" on public.dialer_ai_call_insights;
create policy "dialer_ai_call_insights_admin_read" on public.dialer_ai_call_insights for select to authenticated
  using ((select is_dialer_admin()));
drop policy if exists "Mark own voicemails read" on public.dialer_calls;
create policy "Mark own voicemails read" on public.dialer_calls for update to authenticated
  using (((select is_dialer_admin()) OR ((select is_dialer_user()) AND (user_id = (select auth.uid())))))
  with check (((select is_dialer_admin()) OR ((select is_dialer_user()) AND (user_id = (select auth.uid())))));
drop policy if exists "Read calls" on public.dialer_calls;
create policy "Read calls" on public.dialer_calls for select to authenticated
  using (((select is_dialer_admin()) OR ((select is_dialer_user()) AND (user_id = (select auth.uid())))));
drop policy if exists "Admins manage memberships" on public.dialer_campaign_members;
create policy "Admins manage memberships" on public.dialer_campaign_members for all to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Read own memberships" on public.dialer_campaign_members;
create policy "Read own memberships" on public.dialer_campaign_members for select to authenticated
  using (((user_id = (select auth.uid())) OR (select is_dialer_admin())));
drop policy if exists "dialer_campaign_numbers_admin" on public.dialer_campaign_numbers;
create policy "dialer_campaign_numbers_admin" on public.dialer_campaign_numbers for all to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "dialer_campaign_numbers_read" on public.dialer_campaign_numbers;
create policy "dialer_campaign_numbers_read" on public.dialer_campaign_numbers for select to authenticated
  using (((select is_dialer_admin()) or dialer_can_access_campaign(campaign_id)));
drop policy if exists "Admins manage campaigns" on public.dialer_campaigns;
create policy "Admins manage campaigns" on public.dialer_campaigns for all to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Members read campaigns" on public.dialer_campaigns;
create policy "Members read campaigns" on public.dialer_campaigns for select to authenticated
  using (((select is_dialer_admin()) or dialer_can_access_campaign(id)));
drop policy if exists "Admins add calendar settings" on public.dialer_client_calendars;
create policy "Admins add calendar settings" on public.dialer_client_calendars for insert to authenticated
  with check ((select is_dialer_admin()));
drop policy if exists "Admins edit calendar settings" on public.dialer_client_calendars;
create policy "Admins edit calendar settings" on public.dialer_client_calendars for update to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Reps read their clients' calendar settings" on public.dialer_client_calendars;
create policy "Reps read their clients' calendar settings" on public.dialer_client_calendars for select to authenticated
  using (((select is_dialer_admin()) OR (EXISTS ( SELECT 1 FROM dialer_campaigns c WHERE ((c.airtable_client_id = dialer_client_calendars.airtable_client_id) AND dialer_can_access_campaign(c.id))))));
drop policy if exists "Dialer users read client logos" on public.dialer_client_logos;
create policy "Dialer users read client logos" on public.dialer_client_logos for select to authenticated
  using ((select is_dialer_user()));
drop policy if exists "Admins add contacts" on public.dialer_contacts;
create policy "Admins add contacts" on public.dialer_contacts for insert to authenticated
  with check ((select is_dialer_admin()));
drop policy if exists "Admins delete contacts" on public.dialer_contacts;
create policy "Admins delete contacts" on public.dialer_contacts for delete to authenticated
  using ((select is_dialer_admin()));
drop policy if exists "Admins edit contacts" on public.dialer_contacts;
create policy "Admins edit contacts" on public.dialer_contacts for update to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Members read contacts" on public.dialer_contacts;
create policy "Members read contacts" on public.dialer_contacts for select to authenticated
  using (((select is_dialer_admin()) or dialer_can_access_campaign(campaign_id)));
drop policy if exists "Admins manage custom fields" on public.dialer_custom_fields;
create policy "Admins manage custom fields" on public.dialer_custom_fields for all to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Dialer users read custom fields" on public.dialer_custom_fields;
create policy "Dialer users read custom fields" on public.dialer_custom_fields for select to authenticated
  using ((select is_dialer_user()));
drop policy if exists "Admins manage numbers" on public.dialer_phone_numbers;
create policy "Admins manage numbers" on public.dialer_phone_numbers for all to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Admins read numbers" on public.dialer_phone_numbers;
create policy "Admins read numbers" on public.dialer_phone_numbers for select to authenticated
  using ((select is_dialer_admin()));
drop policy if exists "Admins manage scripts" on public.dialer_scripts;
create policy "Admins manage scripts" on public.dialer_scripts for all to authenticated
  using ((select is_dialer_admin()))
  with check ((select is_dialer_admin()));
drop policy if exists "Reps read their clients' scripts" on public.dialer_scripts;
create policy "Reps read their clients' scripts" on public.dialer_scripts for select to authenticated
  using (((select is_dialer_admin()) OR (EXISTS ( SELECT 1 FROM dialer_campaigns c WHERE ((c.airtable_client_id = dialer_scripts.airtable_client_id) AND dialer_can_access_campaign(c.id))))));
drop policy if exists "Mark own messages read" on public.dialer_sms_messages;
create policy "Mark own messages read" on public.dialer_sms_messages for update to authenticated
  using (((select is_dialer_admin()) OR ((select is_dialer_user()) AND (user_id = (select auth.uid())))))
  with check (((select is_dialer_admin()) OR ((select is_dialer_user()) AND (user_id = (select auth.uid())))));
drop policy if exists "Read messages" on public.dialer_sms_messages;
create policy "Read messages" on public.dialer_sms_messages for select to authenticated
  using (((select is_dialer_admin()) OR ((select is_dialer_user()) AND ((user_id = (select auth.uid())) OR (EXISTS ( SELECT 1 FROM dialer_contacts c WHERE ((c.id = dialer_sms_messages.contact_id) AND dialer_can_access_campaign(c.campaign_id))))))));

-- Campaign periods: count calls per campaign first, then check access once per campaign (not once per call).
create or replace function public.dialer_campaign_periods()
returns table (campaign_id uuid, period_month date, half int, dials int)
language sql stable security definer set search_path = public as $$
  select distinct on (s.campaign_id) s.campaign_id, s.m, s.h, s.n
  from (
    select x.campaign_id,
           date_trunc('month', x.started_at at time zone 'Australia/Sydney')::date as m,
           case when extract(day from x.started_at at time zone 'Australia/Sydney') < 15 then 1 else 2 end as h,
           count(*)::int as n
    from dialer_calls x
    where x.direction = 'outbound' and x.campaign_id is not null
    group by 1, 2, 3
  ) s
  where (select is_dialer_admin()) or dialer_can_access_campaign(s.campaign_id)
  order by s.campaign_id, s.n desc, s.m desc, s.h desc
$$;

-- The 10-minute sweep looks for recordings and transcripts still to finish: index just those calls.
create index if not exists dialer_calls_media_unfinished on public.dialer_calls (updated_at)
  where recording_sid is not null and (recording_path is null or transcript_status is null);
create index if not exists dialer_calls_transcript_skipped on public.dialer_calls (started_at desc)
  where transcript_status = 'skipped' and pickup_status = 'Human Pickup';

-- ── Companies ────────────────────────────────────────────────────────────────────────────────────────────────
-- One row per company, shared across clients, for analysis (backend only: admins can read it, only the server writes).
-- Contacts link to theirs by website domain, else company LinkedIn page, set on every insert or change. The AI labels
-- (company type, industry served, business model, a short summary) are filled in by the companies worker from the
-- website and LinkedIn page; size_bracket is worked out from whatever headcount was uploaded or enriched.

-- "https://www.Acme.com.au/about" → "acme.com.au"; null when there's no usable domain.
create or replace function public.dialer_domain(p_url text) returns text language sql immutable as $$
  select nullif(d, '') from (
    select regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(p_url, ''))), '^[a-z]+://', ''), '^www\.', ''), '[/?#:].*$', '') as d
  ) x where d ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'
$$;

-- "https://www.linkedin.com/company/Acme-Co/about" → "acme-co"; null when it isn't a company page.
create or replace function public.dialer_linkedin_slug(p_url text) returns text language sql immutable as $$
  select nullif(lower((regexp_match(coalesce(p_url, ''), 'linkedin\.com/(?:company|school|showcase)/([^/?#\s]+)', 'i'))[1]), '')
$$;

-- LinkedIn's size brackets from an uploaded or enriched headcount: a count ("54", "1,200") or a range ("51-200",
-- "11 to 50 employees", "10,001+"). A range that isn't one of the brackets goes by its middle. Null when unreadable.
create or replace function public.dialer_size_bracket(p_raw text) returns text language plpgsql immutable as $$
declare
  s text := regexp_replace(lower(coalesce(p_raw, '')), '(\d),(\d{3})', '\1\2', 'g');
  m text[];
  n numeric;
begin
  m := regexp_match(s, '(\d+(?:\.\d+)?)\s*k?\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)');
  if m is not null then
    n := (m[1]::numeric + m[2]::numeric) / 2;
  else
    m := regexp_match(s, '(\d+(?:\.\d+)?)\s*(k)?');
    if m is null then return null; end if;
    n := m[1]::numeric * case when m[2] = 'k' then 1000 else 1 end;
  end if;
  return case when n < 1 then null
              when n <= 10 then '1-10' when n <= 50 then '11-50' when n <= 200 then '51-200' when n <= 500 then '201-500'
              when n <= 1000 then '501-1000' when n <= 5000 then '1001-5000' when n <= 10000 then '5001-10000' else '10001+' end;
end $$;

create table if not exists public.dialer_companies (
  id uuid primary key default gen_random_uuid(),
  domain text unique,
  linkedin_slug text unique,
  linkedin_url text,
  name text,
  -- As uploaded or enriched; size_bracket follows it.
  headcount_raw text,
  size_bracket text generated always as (public.dialer_size_bracket(headcount_raw)) stored,
  company_type text,
  industry_served text,
  business_model text,
  summary text,
  ai_status text not null default 'pending' check (ai_status in ('pending', 'working', 'done', 'no_data', 'error')),
  ai_attempts int not null default 0,
  ai_error text,
  ai_model text,
  ai_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (domain is not null or linkedin_slug is not null)
);
create index if not exists dialer_companies_ai_queue on public.dialer_companies (ai_status, ai_at) where ai_status in ('pending', 'working', 'error');
drop trigger if exists dialer_companies_updated_at on public.dialer_companies;
create trigger dialer_companies_updated_at before update on public.dialer_companies for each row execute function public.dialer_set_updated_at();
alter table public.dialer_companies enable row level security;
drop policy if exists "Admins read companies" on public.dialer_companies;
create policy "Admins read companies" on public.dialer_companies for select to authenticated using ((select is_dialer_admin()));
revoke insert, update, delete on public.dialer_companies from anon, authenticated;

alter table public.dialer_contacts add column if not exists company_id uuid references public.dialer_companies (id) on delete set null;
create index if not exists dialer_contacts_company on public.dialer_contacts (company_id);

-- The company for these details, made if new. Fills in what an existing row is missing (a domain, LinkedIn page, name);
-- an uploaded headcount replaces an older one. A company that gains a domain or LinkedIn page is labelled again.
create or replace function public.dialer_company_for(p_website text, p_linkedin text, p_name text, p_headcount text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  d text := dialer_domain(p_website);
  s text := dialer_linkedin_slug(p_linkedin);
  c public.dialer_companies;
begin
  if d is null and s is null then return null; end if;
  for attempt in 1..2 loop
    select * into c from dialer_companies where domain = d limit 1;
    if c.id is null then select * into c from dialer_companies where linkedin_slug = s limit 1; end if;
    if c.id is null then
      begin
        insert into dialer_companies (domain, linkedin_slug, linkedin_url, name, headcount_raw)
        values (d, s, case when s is not null then trim(p_linkedin) end, nullif(trim(p_name), ''), nullif(trim(p_headcount), ''))
        returning * into c;
        return c.id;
      exception when unique_violation then
        c := null; -- someone else just added it: look again
      end;
    else
      exit;
    end if;
  end loop;
  if c.id is null then return null; end if;

  update dialer_companies set
    domain = case when domain is null and d is not null and not exists (select 1 from dialer_companies where domain = d) then d else domain end,
    linkedin_slug = case when linkedin_slug is null and s is not null and not exists (select 1 from dialer_companies where linkedin_slug = s) then s else linkedin_slug end,
    linkedin_url = case when linkedin_slug is null and s is not null and not exists (select 1 from dialer_companies where linkedin_slug = s) then trim(p_linkedin) else linkedin_url end,
    name = coalesce(name, nullif(trim(p_name), '')),
    headcount_raw = coalesce(nullif(trim(p_headcount), ''), headcount_raw),
    ai_status = case when ai_status = 'no_data' and ((domain is null and d is not null) or (linkedin_slug is null and s is not null)) then 'pending' else ai_status end
  where id = c.id
    and (   (domain is null and d is not null) or (linkedin_slug is null and s is not null) or (name is null and nullif(trim(p_name), '') is not null)
         or (nullif(trim(p_headcount), '') is not null and headcount_raw is distinct from nullif(trim(p_headcount), '')));
  return c.id;
end $$;
revoke execute on function public.dialer_company_for(text, text, text, text) from public, anon, authenticated;

-- Every contact links to its company when added, and again when its website, company or extra fields change.
create or replace function public.dialer_contact_company() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.company_id := coalesce(
    dialer_company_for(new.website, coalesce(new.custom->>'company_linkedin_url', new.custom->>'company_linkedin'), new.company, new.custom->>'company_headcount'),
    case when tg_op = 'UPDATE' then old.company_id end);
  return new;
end $$;
revoke execute on function public.dialer_contact_company() from public, anon, authenticated;
drop trigger if exists dialer_contacts_company on public.dialer_contacts;
create trigger dialer_contacts_company before insert or update of website, company, custom on public.dialer_contacts
  for each row execute function public.dialer_contact_company();

-- The companies worker takes a batch to label: new ones, ones another run left over 20 minutes ago, and failed ones
-- (up to 3 tries, an hour apart). Server only.
create or replace function public.dialer_claim_companies(p_limit int) returns setof public.dialer_companies
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Server only' using errcode = '42501';
  end if;
  return query
    update dialer_companies c set ai_status = 'working', ai_at = now()
    where c.id in (
      select id from dialer_companies
      where ai_status = 'pending'
         or (ai_status = 'working' and ai_at < now() - interval '20 minutes')
         or (ai_status = 'error' and ai_attempts < 3 and ai_at < now() - interval '1 hour')
      order by created_at
      limit p_limit
      for update skip locked)
    returning c.*;
end $$;
revoke execute on function public.dialer_claim_companies(int) from public, anon, authenticated;
grant execute on function public.dialer_claim_companies(int) to service_role;

-- Uploads match a headcount column by more of its usual names.
update public.dialer_custom_fields
set aliases = array(select distinct unnest(aliases || array['employeecount', 'employees', 'headcount', 'companyheadcount', 'companysize', 'numberofemployees', 'employeecountrange', 'employeerange', 'staffcount']))
where key = 'company_headcount';

-- Admins read Clay table links (the Campaigns list shows which campaigns have one connected and matched).
drop policy if exists "Admins read Clay links" on public.dialer_campaign_clay;
create policy "Admins read Clay links" on public.dialer_campaign_clay for select to authenticated using ((select is_dialer_admin()));
grant select on public.dialer_campaign_clay to authenticated;
