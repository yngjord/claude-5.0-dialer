import type { Config } from '@netlify/functions';
import type { AiInsightsStatus } from '../../shared/aiInsights';
import { clayStatus } from '../../shared/clay';
import { aiConfigured, insightQueue, loadCampaign, loadClientContext } from './_lib/aiInsights';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { clayConfigured } from './_lib/clay';
import { db, must } from './_lib/db';
import { handler, HttpError, json, readJson } from './_lib/http';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A run that hasn't finished in this long has died (the background job stops itself after 12 minutes). */
const RUN_STALE_MS = 16 * 60_000;

/**
 * Admins only. GET /api/admin/ai-insights?campaignId=…: what an AI analysis run would cover, and the latest run's
 * progress. POST { campaignId }: starts a run in the background (/api/admin/ai-insights/worker) over the campaign's
 * human pickups that haven't been reviewed yet. Analysis needs two things the campaign itself doesn't: the client's
 * context uploaded in MaronlyOS, and the campaign's Clay table linked and checked (POST /api/admin/ai-insights/clay).
 */
export default handler(async (req) => {
  const me = await requireDialerUser(req);
  requireAdmin(me);
  const campaignId = req.method === 'GET' ? new URL(req.url).searchParams.get('campaignId') : (await readJson<{ campaignId?: string }>(req)).campaignId;
  if (!UUID.test(campaignId ?? '')) throw new HttpError(400, 'Choose a campaign.');
  const campaign = await loadCampaign(campaignId!);
  if (!campaign) throw new HttpError(404, 'Campaign not found.');

  const [context, queue, run, clayRow] = await Promise.all([
    loadClientContext(campaign.airtable_client_id),
    insightQueue(campaign.id),
    db().from('dialer_ai_insight_runs').select('started_at, finished_at, total, done, failed, error').eq('campaign_id', campaign.id).maybeSingle().then(must),
    db().from('dialer_campaign_clay').select('*').eq('campaign_id', campaign.id).maybeSingle().then(must),
  ]);
  const clay = clayRow ? clayStatus(clayRow as Parameters<typeof clayStatus>[0]) : null;
  const lastRun = run as { started_at: string; finished_at: string | null; total: number; done: number; failed: number; error: string | null } | null;
  const running = !!lastRun && !lastRun.finished_at && Date.now() - new Date(lastRun.started_at).getTime() < RUN_STALE_MS;

  if (req.method === 'GET') {
    return json({
      configured: aiConfigured(),
      clientName: campaign.client_name,
      contextReady: !!context,
      clayConfigured: clayConfigured(),
      clay,
      toAnalyse: queue.toAnalyse.length,
      analysed: queue.analysed,
      awaitingTranscript: queue.awaitingTranscript,
      running,
      lastRun: lastRun
        ? { startedAt: lastRun.started_at, finishedAt: lastRun.finished_at, total: lastRun.total, done: lastRun.done, failed: lastRun.failed, error: lastRun.error }
        : null,
    } satisfies AiInsightsStatus);
  }

  if (!aiConfigured()) throw new HttpError(409, 'The Claude API key isn’t set up on this site yet.');
  if (!context) throw new HttpError(409, `Upload ${campaign.client_name}’s context in MaronlyOS first. The analysis uses it to judge each call.`);
  if (!clay?.valid) throw new HttpError(409, 'Link this campaign’s Clay table and check it first.');
  if (!queue.toAnalyse.length) throw new HttpError(409, 'There are no new conversations to analyse.');
  const started = must(await db().rpc('dialer_ai_insight_start_run', { p_campaign_id: campaign.id, p_user_id: me.userId, p_total: queue.toAnalyse.length })) as boolean;
  if (!started) throw new HttpError(409, 'An analysis is already running for this campaign.');

  // The background job replies 202 straight away and carries on for up to 15 minutes. It checks the same login.
  const res = await fetch(new URL('/api/admin/ai-insights/worker', req.url), {
    method: 'POST',
    headers: { Authorization: req.headers.get('authorization') ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignId: campaign.id }),
  });
  if (!res.ok) {
    must(await db().from('dialer_ai_insight_runs').update({ finished_at: new Date().toISOString(), error: 'The analysis couldn’t start. Try again.' }).eq('campaign_id', campaign.id));
    throw new HttpError(502, 'The analysis couldn’t start. Try again.');
  }
  return json({ started: true, total: queue.toAnalyse.length });
});

export const config: Config = { path: '/api/admin/ai-insights', method: ['GET', 'POST'] };
