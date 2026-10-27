# JustCall backfill (planned, not built yet)

Agreed 27 Oct 2026; on hold until the team has finished dialling in JustCall. Bring this up when we look at
backfilling.

## The export

From JustCall, filtered to **calls from 1 May 2026 onwards, 0.5 minutes or longer** (about 800 calls). It must include
the **Recording url** column (the `jc-recordings.s3.amazonaws.com` links download without a JustCall login). Add
Call ID / Contact ID columns if JustCall's export offers them; if not, match each call to Airtable's
`JustCall Storage` (which has both) by phone + date/time or by recording link, before those tables are deleted.

## What the backfill does (a one-off script, safe to re-run)

1. Inserts each call into `dialer_calls` with `source = 'justcall'` (new dials are `'dialer'`), plus
   `justcall_call_id` / `justcall_contact_id` when we have them. Performance and number-health stats already count
   `source = 'dialer'` only. Show a "JustCall" badge on these rows in Call logs.
2. Downloads each recording, converts it to MP3 (ffmpeg, both channels kept so rep and prospect stay separate), and
   uploads it to the private `dialer-recordings` bucket.
3. Repoints Airtable Leads → `Call Recording Link` from JustCall S3 links to our `/r/{callId}.mp3` links, so the
   portal and OS keep working after JustCall is deleted. (`/r/` only serves Interested dispositions.)
4. Prints counts and failures to check.

Transcripts are optional: pull them from JustCall's API while the account exists (needs a JustCall API key as a
Netlify/env secret, and whichever of call ID / contact ID their API wants), or generate them later with Twilio Voice
Intelligence from the stored recordings.

## Storage and cost

- JustCall recordings are 2-channel 8 kHz WAV, about 1.9 MB per minute. Calls of 30s+ averaged about 1.5 minutes,
  so ~800 calls is ~1,200 minutes: about 2.3 GB as WAV, about 0.6 GB as MP3.
- Supabase is on Pro (100 GB storage and 250 GB egress included; then about US$0.021/GB-month), so no extra cost.
- Run the script from a Claude session, not Netlify: no Netlify credits, and S3 downloads are free.

## Order

1. Finish dialling in JustCall, then export as above.
2. Run the backfill (and again to catch the last calls), check counts and a few recordings.
3. Then delete the Airtable `JustCall Storage` / `Cold Call Transcripts` tables and their link fields, and cancel
   JustCall.
