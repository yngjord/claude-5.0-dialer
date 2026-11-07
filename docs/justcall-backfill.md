# JustCall backfill (done 31 Oct 2026)

A one-off import of the JustCall calls worth keeping, with their recordings. The temporary code that ran it has been
deleted; this note records what was done.

## What was imported

- **Source:** JustCall's Sales Dialer export, calls from 1 May 2026 that lasted 0.5 minutes or more (874 rows; one test
  call, "Re: Kintell FAKE CAMPAIGN WH TEST", was skipped), plus 4 calls linked from Airtable leads that the export left
  out. **877 calls** in `dialer_calls` with `source = 'justcall'` and `pickup_source = 'import'`.
- **Fields:** rep (`user_id`, `agent_name`), client (from the campaign name), campaign, contact name, email, company,
  LinkedIn, website, phone, the JustCall number called from, pickup status, disposition, notes, start/end/duration,
  Twilio call SID, and JustCall's Call ID / Contact ID (`justcall_call_id`, `justcall_contact_id`). Not kept (no
  column): address, country, lookalike fields, customer type, rating, attempts, ring time, cost.
- **Dispositions outside the dialer's list:** Product/Service Not Needed and Already Using Competitor → Not
  Interested; Language Barrier → Unqualified Lead; Follow-Up Required, Needs More Time and Decision Maker Unavailable →
  none. Each keeps JustCall's wording at the start of its notes, e.g. `[JustCall: Follow-Up Required]`.
- **Stats:** Performance and number health count `source = 'dialer'` only, so these don't change them. Call logs show a
  "JustCall" badge on them.

## Recordings

- **682 calls** have their recording in the `dialer-recordings` bucket as `{callId}.mp3` (32 kbps, both channels kept),
  245 MB in all. Links came from Airtable's `JustCall Storage` and JustCall's API (matched by Twilio call SID;
  timing and recording-length matches made earlier all agreed with it, bar one that was corrected).
- **195 calls have no recording:** 188 from May–July (JustCall's API only returns the last 3 months, and Airtable never
  captured them) and 7 where JustCall had none.
- No transcripts: JustCall's API returned none (`justcall_ai` was empty). The recordings can be transcribed with
  Twilio Voice Intelligence later if needed.

## Airtable leads

All 147 leads that linked a JustCall S3 recording now link `https://dialer.maronly.com.au/r/{callId}.mp3`, and the
call carries the lead's id (`airtable_lead_id`), which `/r/` also accepts. No lead links a JustCall recording any more.

## After this

The Airtable `JustCall Storage` and `Cold Call Transcripts` tables (and the Leads → `Cold Call Transcripts` /
`JustCall Dialer Link` and Clients → `JustCall Storage` link fields) and the JustCall account are no longer needed by
the dialer, portal recording links or this import. Remove the `JUSTCALL_API_KEY` / `JUSTCALL_API_SECRET` variables from
Netlify.

## Second pass: every other dial (done 7 Nov 2026, data only)

JustCall's full "All dials" export (3,013 calls) matched all 877 calls above by Twilio call SID, with no duplicates. The
other **2,114 dials** (all 30 seconds or shorter) were added so dial counts and pickup rates cover all of JustCall,
**without recordings** (checked: none were meetings or real conversations worth keeping). Skipped: 18 test calls
(`TESTING JORDAN`, `FAKE CAMPAIGN`, `WEBHOOK TEST`) and 4 setup calls from 26–27 April.

Pickup status was set conservatively, so historical human pickup rates err low rather than high:

- JustCall's Failed / Busy / Unanswered and Machine Pickup are kept as is.
- **Human Pickup only** when the disposition means a conversation (Interested, Not Interested, Unqualified, Do Not
  Call, Language Barrier, …), the call lasted 5+ seconds, and the notes don't mention voicemail: **78 calls**.
- Machine Pickup when the disposition is Left Voicemail or the notes say voicemail ("vmail", "Reached voicemail").
- Everything else is **Unclassified Pickup**, including JustCall's own "Human Pickup" flag on its own (it marked 0–1
  second calls as human) and Wrong Number.

All JustCall calls together: 2,991 dials, 630 Human Pickup. Dispositions use the same mapping as above.
