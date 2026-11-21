import type { Config } from '@netlify/functions';
import { AI_INSIGHTS_CONCURRENCY, AI_INSIGHTS_DEADLINE_MS } from '../../shared/aiInsights';
import { insightQueue, loadCallForReview, loadCampaign, loadClientContext, reviewCall } from './_lib/aiInsights';
import { requireAdmin, requireDialerUser } from './_lib/auth';
import { db, must } from './_lib/db';

/**
 * Background job (admins only), started by POST /api/admin/ai-insights: reviews every human pickup in the campaign
 * that has a transcript and no review yet, four at a time, saving each review as it lands so progress shows and a
 * stopped run loses nothing. Stops taking new calls after 12 minutes (the platform ends background jobs at 15); what's
 * left is picked up by the next run. Never throws: Netlify would retry the whole job.
 */
export default async (req: Request) => {
  let campaignId: string | null = null;
  const finish = async (error: string | null, done: number, failed: number) => {
    if (!campaignId) return;
    try {
      must(await db().from('dialer_ai_insight_runs').update({ finished_at: new Date().toISOString(), done, failed, error }).eq('campaign_id', campaignId));
    } catch (err) {
      console.error('AI insights: could not record the run end', campaignId, err);
    }
  };

  let done = 0;
  let failed = 0;
  try {
    const requested = ((await req.json()) as { campaignId?: string }).campaignId ?? null;
    // Only a signed-in admin's request may touch the run (so no one else can end one early).
    requireAdmin(await requireDialerUser(req));
    campaignId = requested;
    const campaign = campaignId ? await loadCampaign(campaignId) : null;
    if (!campaign) return;
    const context = await loadClientContext(campaign.airtable_client_id);
    if (!context) return await finish(`${campaign.client_name}’s context isn’t uploaded in MaronlyOS yet.`, 0, 0);

    const { toAnalyse } = await insightQueue(campaign.id);
    must(await db().from('dialer_ai_insight_runs').update({ total: toAnalyse.length }).eq('campaign_id', campaign.id));
    const deadline = Date.now() + AI_INSIGHTS_DEADLINE_MS;
    let next = 0;
    let firstError: string | null = null;

    const worker = async () => {
      while (next < toAnalyse.length && Date.now() < deadline) {
        const callId = toAnalyse[next++];
        try {
          const call = await loadCallForReview(callId);
          if (!call) continue;
          const review = await reviewCall(campaign.client_name, context, call);
          // A review is made once per call; if two runs ever overlapped, the first one stays.
          must(
            await db()
              .from('dialer_ai_call_insights')
              .upsert({ call_id: callId, ...review, context_version: context.version }, { onConflict: 'call_id', ignoreDuplicates: true }),
          );
          done++;
        } catch (err) {
          failed++;
          firstError ??= err instanceof Error ? err.message : String(err);
          console.error('AI insights: review failed', callId, err);
        }
        // Progress for the admin's screen; a missed update is fine (the next one or the end catches up).
        await db().from('dialer_ai_insight_runs').update({ done, failed }).eq('campaign_id', campaign.id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(AI_INSIGHTS_CONCURRENCY, toAnalyse.length) }, worker));

    const left = toAnalyse.length - done - failed;
    const notes = [
      failed ? `${failed} call${failed === 1 ? '' : 's'} couldn’t be analysed (${firstError}). Run it again to retry them.` : null,
      left > 0 ? `Stopped after 12 minutes with ${left} left. Run it again to carry on.` : null,
    ].filter(Boolean);
    await finish(notes.length ? notes.join(' ') : null, done, failed);
  } catch (err) {
    console.error('AI insights run failed', campaignId, err);
    await finish(err instanceof Error ? err.message : 'The analysis stopped unexpectedly.', done, failed);
  }
};

export const config: Config = { path: '/api/admin/ai-insights/worker', method: 'POST', background: true };
