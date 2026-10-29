/**
 * Call scripts: plain text with {{variables}} filled in from the contact being called, the rep and the campaign, so
 * the rep can read it straight out. Custom fields use their key, e.g. {{industry}}.
 */

export interface ScriptVariable {
  key: string;
  label: string;
}

/** Built-in variables, in the order the editor lists them. */
export const SCRIPT_VARIABLES: ScriptVariable[] = [
  { key: 'first_name', label: 'First name' },
  { key: 'full_name', label: 'Full name' },
  { key: 'company', label: 'Company' },
  { key: 'title', label: 'Job title' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'agent_first_name', label: 'Your first name' },
  { key: 'agent_name', label: 'Your full name' },
  { key: 'client_name', label: 'Client' },
  { key: 'campaign_name', label: 'Campaign' },
];

export interface ScriptContext {
  contact: {
    full_name: string | null;
    first_name: string | null;
    company: string | null;
    title: string | null;
    email: string | null;
    website: string | null;
    custom: Record<string, string> | null;
  };
  agentName: string | null;
  clientName: string | null;
  campaignName: string | null;
}

/** A piece of a rendered script: text, a filled-in variable, or a variable with no value for this contact. */
export type ScriptPart = { kind: 'text'; text: string } | { kind: 'value'; key: string; text: string } | { kind: 'missing'; key: string; text: string };

const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** "https://www.acme.com/" → "acme.com", so a script can say "I was on acme.com". */
const bareWebsite = (url: string) => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');

export function scriptValues(ctx: ScriptContext): Record<string, string> {
  const c = ctx.contact;
  const first = c.first_name?.trim() || c.full_name?.trim().split(/\s+/)[0] || '';
  const values: Record<string, string> = {};
  // Custom fields first, so a built-in with the same key wins.
  for (const [k, v] of Object.entries(c.custom ?? {})) if (v?.trim()) values[k.toLowerCase()] = v.trim();
  Object.assign(values, {
    first_name: first,
    full_name: c.full_name?.trim() ?? '',
    company: c.company?.trim() ?? '',
    title: c.title?.trim() ?? '',
    email: c.email?.trim() ?? '',
    website: c.website ? bareWebsite(c.website.trim()) : '',
    agent_first_name: ctx.agentName?.trim().split(/\s+/)[0] ?? '',
    agent_name: ctx.agentName?.trim() ?? '',
    client_name: ctx.clientName?.trim() ?? '',
    campaign_name: ctx.campaignName?.trim() ?? '',
  });
  return values;
}

/** Splits a script into text and variables, filled in for this call. Unknown or empty variables come back as `missing`. */
export function renderScript(body: string, ctx: ScriptContext): ScriptPart[] {
  const values = scriptValues(ctx);
  const parts: ScriptPart[] = [];
  let last = 0;
  for (const m of body.matchAll(VARIABLE)) {
    if (m.index! > last) parts.push({ kind: 'text', text: body.slice(last, m.index) });
    const key = m[1].toLowerCase();
    const value = values[key];
    parts.push(value ? { kind: 'value', key, text: value } : { kind: 'missing', key, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) });
  return parts;
}
