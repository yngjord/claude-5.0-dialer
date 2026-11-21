import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import {
  AI_INSIGHTS_INSTRUCTIONS,
  AI_INSIGHTS_MODEL,
  bulletText,
  callForReview,
  contextBlock,
  type CallForReview,
} from '../../../shared/aiInsights';
import { db, must } from './db';
import { env } from './http';

/** The client's full context is used up to this size; above it, the shorter brief MaronlyOS builds alongside it. */
const MAX_CONTEXT_TOKENS = 150_000;

export interface ClientContext {
  text: string;
  version: string | null;
}

/** The client's context pack from MaronlyOS, or null while it isn't built yet (runs are blocked until it is). */
export async function loadClientContext(airtableClientId: string): Promise<ClientContext | null> {
  const pack = must(
    await db()
      .from('dialer_client_context_packs')
      .select('brief, full_context, full_tokens, version, status')
      .eq('airtable_client_id', airtableClientId)
      .maybeSingle(),
  ) as { brief: string | null; full_context: string | null; full_tokens: number | null; version: string | null; status: string } | null;
  if (!pack || pack.status !== 'ready') return null;
  const full = pack.full_context?.trim() && (pack.full_tokens ?? 0) <= MAX_CONTEXT_TOKENS ? pack.full_context : null;
  const text = (full ?? pack.brief ?? '').trim();
  return text ? { text, version: pack.version } : null;
}

export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY?.trim();

const Review = z.object({
  summary: z.string(),
  positives: z.array(z.string()),
  negatives: z.array(z.string()),
});

let client: Anthropic | null = null;
const claude = () => (client ??= new Anthropic({ apiKey: env('ANTHROPIC_API_KEY'), maxRetries: 4 }));

/**
 * Reviews one call with Claude. The instructions and the client's context come first and are cached, so every call
 * after the first in a run reads them at a fraction of the price. If Claude's safety checks decline a call, the API
 * retries it on its default fallback model in the same request.
 */
export async function reviewCall(clientName: string, context: ClientContext, call: CallForReview) {
  const res = await claude().beta.messages.parse({
    model: AI_INSIGHTS_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: betaZodOutputFormat(Review) },
    system: [
      { type: 'text', text: AI_INSIGHTS_INSTRUCTIONS },
      { type: 'text', text: contextBlock(clientName, context.text), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: callForReview(call) }],
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to review this call.');
  if (res.stop_reason === 'max_tokens' || !res.parsed_output) throw new Error('Claude’s review came back incomplete.');
  const out = res.parsed_output;
  return { summary: out.summary.trim(), positives: bulletText(out.positives), negatives: bulletText(out.negatives), model: res.model };
}

/** A campaign's human pickups: which can be reviewed now, which are done, which wait for a transcript. */
export async function insightQueue(campaignId: string) {
  const rows = must(await db().rpc('dialer_ai_insight_queue', { p_campaign_id: campaignId })) as { call_id: string; has_transcript: boolean; analysed: boolean }[];
  return {
    toAnalyse: rows.filter((r) => r.has_transcript && !r.analysed).map((r) => r.call_id),
    analysed: rows.filter((r) => r.analysed).length,
    awaitingTranscript: rows.filter((r) => !r.has_transcript && !r.analysed).length,
  };
}

/** The campaign fields a run needs. */
export async function loadCampaign(campaignId: string) {
  return must(await db().from('dialer_campaigns').select('id, name, client_name, airtable_client_id').eq('id', campaignId).maybeSingle()) as {
    id: string;
    name: string;
    client_name: string;
    airtable_client_id: string;
  } | null;
}

/** One call, shaped for the review. */
export async function loadCallForReview(callId: string): Promise<CallForReview | null> {
  const row = must(
    await db()
      .from('dialer_calls')
      .select('agent_name, full_name, company, campaign_name, started_at, duration_s, disposition, notes, transcript, transcript_json, contact:dialer_contacts(title)')
      .eq('id', callId)
      .maybeSingle(),
  ) as {
    agent_name: string | null;
    full_name: string | null;
    company: string | null;
    campaign_name: string | null;
    started_at: string;
    duration_s: number | null;
    disposition: string | null;
    notes: string | null;
    transcript: string | null;
    transcript_json: CallForReview['transcriptJson'];
    contact: { title: string | null } | null;
  } | null;
  if (!row) return null;
  return {
    agentName: row.agent_name,
    prospectName: row.full_name,
    title: row.contact?.title ?? null,
    company: row.company,
    campaignName: row.campaign_name,
    startedAt: row.started_at,
    durationS: row.duration_s,
    disposition: row.disposition,
    notes: row.notes,
    transcriptJson: row.transcript_json,
    transcript: row.transcript,
  };
}
