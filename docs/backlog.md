# Backlog

## Admin performance view (requested 24 Oct 2026)
A separate tab in the admin section for team and client performance (separate from the reps' Call logs):
- Break down by team member and by client, optionally by campaign.
- Time windows: This month, Last month, All time, plus the existing presets and custom dates.
- Metrics per row: dials, connects, connect rate, appointments, follow-ups, talk time (same as the Campaigns
  metrics), with totals.
- Likely approach: a `dialer_performance_stats(p_from, p_to, p_client_name, p_campaign_id)` RPC grouped by
  user and client (security invoker, so RLS still applies), plus an `/admin/performance` page with filters
  and sortable tables.
