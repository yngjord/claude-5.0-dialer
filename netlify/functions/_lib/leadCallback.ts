import { normalizeCallable } from '../../../shared/phone';
import { LEAD_FIELDS, todayInSydney } from '../../../shared/leads';
import { listAll, updateRecord } from './airtable';
import { db } from './db';

// A phone number at most this many leads share before we stop guessing which one called (shared office lines).
const MAX_LEADS = 5;

/**
 * Someone called one of our numbers back: put their Airtable lead(s) back in front of the team by setting Next
 * Follow-up to today and Record Status to Open. Leads are found by the caller's number: first the ones the dialer
 * created (linked on our calls/contacts), else Leads whose Phone Number is the same number however it's written
 * ("0421 034 467" = "+61 421 034 467"). Returns the lead ids updated.
 */
export async function markLeadsCalledBack(callerE164: string): Promise<string[]> {
  const [{ data: calls }, { data: contacts }] = await Promise.all([
    db().from('dialer_calls').select('airtable_lead_id').eq('phone_e164', callerE164).not('airtable_lead_id', 'is', null).limit(MAX_LEADS),
    db().from('dialer_contacts').select('airtable_lead_id').eq('phone_e164', callerE164).not('airtable_lead_id', 'is', null).limit(MAX_LEADS),
  ]);
  let ids = [...new Set([...(calls ?? []), ...(contacts ?? [])].map((r) => r.airtable_lead_id as string))];

  if (!ids.length) {
    // Narrow by the last 8 digits in Airtable, then keep exact matches only.
    const tail = callerE164.replace(/\D/g, '').slice(-8);
    const candidates = await listAll<Record<string, string>>('Leads', {
      filterByFormula: `RIGHT(REGEX_REPLACE({Phone Number} & '', '[^0-9]', ''), 8) = '${tail}'`,
      fields: [LEAD_FIELDS.phone],
      byFieldId: true,
    });
    ids = candidates.filter((l) => {
      const p = normalizeCallable(l.fields[LEAD_FIELDS.phone]);
      return p.ok && p.e164 === callerE164;
    }).map((l) => l.id);
  }
  if (!ids.length || ids.length > MAX_LEADS) return [];

  const today = todayInSydney();
  for (const id of ids) await updateRecord('Leads', id, { [LEAD_FIELDS.nextFollowUp]: today, [LEAD_FIELDS.recordStatus]: 'Open' });
  return ids;
}
