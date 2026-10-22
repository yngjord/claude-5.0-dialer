# Maronly Dialer

Maronly's cold calling app: a power dialer and click-to-call, built on Twilio. It replaces JustCall.
The design and stack match the client portal (`claude-2.0-portal`) and MaronlyOS.

```
Browser (React + Vite)
  ├─ Supabase Auth (same project and logins as the portal; only role = team/admin)
  ├─ Supabase (campaigns, contacts, calls, SMS) via RLS, plus realtime for live call status and new texts
  ├─ Twilio Voice SDK (WebRTC, Sydney edge) ── audio ── Twilio ── +61/+64 mobiles
  └─ /api/* (Bearer Supabase token) ─▶ Netlify Functions
         ├─ Twilio webhooks (signature checked): outbound TwiML, call status, AMD, recordings, transcripts,
         │  inbound voicemail and SMS
         ├─ Supabase with the service role key (server only)
         └─ Airtable Leads (created for "Interested" dispositions; never updated)
```

## How it works

- **Who can use it.** Anyone whose `profiles.role` is `team` or `admin`. Portal clients get "This app is for the
  Maronly team". Admins see every campaign. Team members only see the campaigns they're ticked for in
  **Manage campaigns**. RLS enforces this in the database, not just in the UI.
- **Campaigns and contacts.** Each campaign belongs to one Airtable client: calls show in that client's Cold Call
  Logs, and Leads are linked to them. Contacts come from a CSV upload. Only AU (+614) and NZ (+642) mobiles are
  accepted, and duplicate numbers within a campaign are skipped. A local number written like `02 9876 5432` is
  read as an AU landline, so write NZ `027/028/029` mobiles with +64.
- **Power dialer.** `claim_next_contact()` hands each rep the next due contact and locks it to them, so two reps
  never get the same person. After a countdown (or straight away, or on demand) the browser dials. After hanging
  up, the rep fills in the wrap-up form and the next contact is dialed. No Answer and Left Voicemail come back
  after the campaign's retry delay until the max number of dials. Do Not Call applies to that number in every
  campaign.
- **Click-to-call.** The phone button on any contact. Same call logging and wrap-up, shown in a bar above the page.
- **Pickup status.** Twilio's call status and answering machine detection (AMD) are written to the call row
  by webhooks. The `calls_pickup` trigger turns them into Human / Machine / Unclassified Pickup, Unanswered, Busy
  or Failed, so it's filled in even if the rep closes the tab. The rep can correct it at wrap-up, and then it's
  never overwritten (`pickup_source = 'agent'`). The raw values stay in `twilio_status` and `answered_by`.
- **No abandoned calls.** The rep hears the line from the first ring (`answerOnBridge`); AMD only labels the call.
- **Interested dispositions.**
  - *Interested - Needs Follow-Up* creates a Lead with Stage `Nurture` and `Next follow up`.
  - *Interested - Appointment Set* creates a Lead with Stage `Booking`, `Booked For`, `Time Booked for (plain text)`
    (e.g. `2:30pm AEDT`) and `Date Booked`.
  - Both set Channel `Cold Call`, Record Status `Open`, Client, Campaign Name, name, email, phone, LinkedIn and
    website. The rep's notes go in `Notes (Maronly)`.
  - If Airtable fails, the call is still saved and the rep can retry. All Lead field names are in `shared/leads.ts`.
- **Recordings and transcripts.** Dual-channel recordings are copied from Twilio into the private Supabase bucket
  `recordings`, then deleted from Twilio. Calls that might have been a conversation (not machines, 5s+) and all
  voicemails are transcribed with Twilio Voice Intelligence, with rep and prospect on separate channels.
  `sweep` (every 10 minutes) finishes anything a webhook didn't.
- **Inbound.** There are no live inbound calls. Callers hear the number's greeting (the standard spoken one, or an
  upload in **Phone numbers**) and can leave a voicemail. Voicemails and texts go to the Inbox of the rep who last
  called or texted that number.
- **Caller ID.** Calls go out from the rep's own number, else the campaign's number, else the default number.

Every table, policy and function is in [`supabase/migrations/20261022000000_dialer.sql`](supabase/migrations/20261022000000_dialer.sql).

## Setup

### 1. Supabase

Run `supabase/migrations/20261022000000_dialer.sql` in the SQL editor of the portal's project. It's safe to
re-run. It adds the dialer tables, a `display_name` column on `profiles` (shown as the agent name), the
`recordings` and `greetings` storage buckets and realtime on `calls` and `sms_messages`. It doesn't change
anything the portal uses.

Then for each person:
- Set `profiles.role` to `team` (or `admin`).
- Fill in `profiles.display_name`.

### 2. Twilio

1. Create the account and upgrade it. Trial accounts can only call verified numbers.
2. **Regulatory compliance → Bundles:** create an Australian business bundle (ABN, business address). AU mobile
   numbers need an approved bundle, and approval can take a few business days.
3. **Buy AU mobile numbers (+61 4…)**, ideally one per rep. They support voice and SMS. AU local (02/03)
   numbers can't send texts.
4. **Voice → Settings → Geo permissions:** allow only Australia and New Zealand. Do the same under
   **Messaging → Settings → Geo permissions**.
5. **Account → API keys:** create a *Standard* key. Keep the SID (`SK…`) and secret.
6. Deploy the site (step 3), then run the setup script against it. It creates the TwiML App and the Voice
   Intelligence service, sets the voicemail/SMS webhooks on every number, and prints the SIDs:
   ```bash
   TWILIO_ACCOUNT_SID=AC… TWILIO_API_KEY_SID=SK… TWILIO_API_KEY_SECRET=… \
   PUBLIC_BASE_URL=https://dialer.maronly.com.au npm run setup:twilio
   ```
7. In the app, sign in as an admin, open **Phone numbers → Sync from Twilio**, and assign numbers to reps.

### 3. Netlify

Create a **new** Netlify site from this repo (separate from the portal) and give it its own subdomain, e.g.
`dialer.maronly.com.au`. The build settings come from `netlify.toml`. Environment variables:

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL`, `SUPABASE_URL` | The portal's Supabase URL |
| `VITE_SUPABASE_ANON_KEY`, `SUPABASE_ANON_KEY` | Its anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret.** Its service role key (functions only) |
| `AIRTABLE_API_KEY` | **Secret.** A new token for this app: `data.records:read` + `data.records:write`, Maronly base only |
| `AIRTABLE_BASE_ID` | `appD9XqU0PeqPm3Mj` |
| `TWILIO_ACCOUNT_SID` | `AC…` |
| `TWILIO_AUTH_TOKEN` | **Secret.** Used to check webhook signatures |
| `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` | The API key from step 2.5 |
| `TWILIO_TWIML_APP_SID`, `TWILIO_INTELLIGENCE_SERVICE_SID` | Printed by `npm run setup:twilio` |

Netlify scheduled functions (`sweep`) run on production deploys only.

### 4. Moving off JustCall

1. Dial a few test calls (your own mobile: answer, let it ring out, let it go to voicemail).
2. Copy the history into Supabase. Use `--dry-run` first; re-running only adds what's new:
   ```bash
   AIRTABLE_API_KEY=… AIRTABLE_BASE_ID=appD9XqU0PeqPm3Mj SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
     npm run backfill:justcall -- --dry-run
   ```
   Transcripts are matched to calls via their Lead's phone number, since their `JustCall Call ID` isn't filled in.
3. Deploy the portal change that reads Cold Call Logs from Supabase, and check a client's numbers match.
4. Turn off whatever writes JustCall calls into Airtable, then run the backfill once more.
5. Only then delete `JustCall Storage` and `Cold Call Transcripts` in Airtable, along with the fields that link to
   them: Leads → `Cold Call Transcripts` and `JustCall Dialer Link`; Clients → `JustCall Storage`.

## Local development

```bash
npm install
cp .env.example .env    # fill in the values
npx netlify-cli dev     # http://localhost:8888 (Vite and the functions together)
```

Twilio has to reach your webhooks, so for calls you need a tunnel (e.g. `ngrok http 8888`). Set `PUBLIC_BASE_URL`
to the tunnel URL and point the TwiML App's Voice URL at `<tunnel>/api/twilio/voice`.

Checks: `npm run typecheck`, `npm run lint`, `npm test` (shared logic, plus the migration on an in-memory
Postgres: RLS, the queue lock and the pickup trigger), `npm run build`.
