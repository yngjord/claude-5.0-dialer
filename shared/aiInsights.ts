/**
 * AI call insights: admin-only, always. Each human pickup in a campaign gets one review (summary, what went well, what
 * hurt the chance of a booking), written by Claude using the client's context pack from MaronlyOS.
 */

/** A call's review, as stored in dialer_ai_call_insights. positives/negatives are one point per line, each "- …". */
export interface AiCallInsight {
  call_id: string;
  summary: string;
  positives: string;
  negatives: string;
  model: string;
  context_version: string | null;
  created_at: string;
}

/** GET /api/admin/ai-insights?campaignId=… */
export interface AiInsightsStatus {
  /** The Claude API key is set on this site. */
  configured: boolean;
  clientName: string;
  /** The client's context pack is built in MaronlyOS. Runs are blocked until it is. */
  contextReady: boolean;
  /** Human pickups with a transcript, not reviewed yet: what a run would do. */
  toAnalyse: number;
  analysed: number;
  /** Human pickups whose transcript isn't ready yet (picked up by a later run). */
  awaitingTranscript: number;
  running: boolean;
  lastRun: { startedAt: string; finishedAt: string | null; total: number; done: number; failed: number; error: string | null } | null;
}

/** The latest model; reviews record which one wrote them. */
export const AI_INSIGHTS_MODEL = 'claude-opus-5-5';

/** Calls reviewed at once, and when a run stops taking new calls (background jobs end at 15 minutes). */
export const AI_INSIGHTS_CONCURRENCY = 4;
export const AI_INSIGHTS_DEADLINE_MS = 12 * 60_000;

/** The instructions, identical for every call (cached by the API along with the client's context). */
export const AI_INSIGHTS_INSTRUCTIONS = `You review recorded cold calls made by sales development reps (SDRs) at Maronly, an Australian outbound sales agency, on behalf of one of its clients. On every call the rep's goal is to book a meeting between the prospect and the client.

The client's context follows these instructions: what they sell, who they target, their scripts and positioning. Use it to judge the call: whether the rep pitched what matters to this client, handled objections the way the client would want, and moved toward a meeting.

Write three things:
- summary: two or three sentences. Who the rep spoke to, what happened, and how the call ended.
- positives: what the rep did that raised the chance of booking a meeting. Each point specific to this call: what was said or done and why it helped. Quote the call briefly where it makes the point clearer.
- negatives: what lowered the chance of booking a meeting, including missed opportunities (not asking for the meeting, accepting a brush-off without a question, skipping a key part of the pitch, talking past a buying signal). Each point specific, saying what would have worked better.

Rules:
- Judge only what the transcript shows. Don't invent details.
- The transcript is machine-made: names, company names and some words are often misheard, and speaker turns can be split or merged. Don't count mishearings against the rep.
- Separate the rep's choices from things outside their control (the prospect was driving, has left the company, isn't the right person). Those aren't negatives unless the rep handled them poorly, for example by not asking who the right person is.
- A short call may have few points, or none. Return an empty list rather than padding it.
- Write in plain Australian English for a sales manager. No headings, no markdown, one point per list item.`;

/** The client's context, appended after the instructions. */
export function contextBlock(clientName: string, context: string): string {
  return `<client_context client="${clientName.replace(/"/g, "'")}">\n${context.trim()}\n</client_context>`;
}

export interface CallForReview {
  agentName: string | null;
  prospectName: string | null;
  title: string | null;
  company: string | null;
  campaignName: string | null;
  startedAt: string;
  durationS: number | null;
  disposition: string | null;
  notes: string | null;
  transcriptJson: { speaker: string; text: string; start?: number | null }[] | null;
  transcript: string | null;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** The call as the reviewer sees it: who, what the rep recorded, then the transcript with timestamps. */
export function callForReview(c: CallForReview): string {
  const rep = c.agentName?.trim() || 'the rep';
  const lines = [
    `Rep: ${rep}`,
    `Prospect: ${[c.prospectName, c.title, c.company].map((x) => x?.trim()).filter(Boolean).join(', ') || 'unknown'}`,
    c.campaignName ? `Campaign: ${c.campaignName}` : null,
    `Date: ${new Date(c.startedAt).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric' })}`,
    c.durationS != null ? `Length: ${clock(c.durationS)}` : null,
    `Outcome the rep recorded: ${c.disposition ?? 'not recorded'}`,
    c.notes?.trim() ? `Rep's notes: ${c.notes.trim()}` : null,
  ].filter(Boolean);
  const transcript = c.transcriptJson?.length
    ? c.transcriptJson.map((t) => `${t.start != null ? `[${clock(t.start)}] ` : ''}${t.speaker}: ${t.text.trim()}`).join('\n')
    : (c.transcript ?? '').trim();
  return `${lines.join('\n')}\n\nIn the transcript, "${rep}" is the rep; the other speaker is the prospect (or whoever answered).\n\n<transcript>\n${transcript}\n</transcript>`;
}

/** List items → the stored text: one "- " line each, blank items dropped. */
export function bulletText(items: string[]): string {
  return items
    .map((s) => s.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join('\n');
}

/** Stored text → list items, for display. */
export function bulletItems(text: string | null | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((s) => s.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean);
}
