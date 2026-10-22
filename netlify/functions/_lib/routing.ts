import { db } from './db';

/**
 * Who an inbound call or text from this number belongs to: the most recent contact with that number, and the rep
 * who last called or texted it (they get the notification).
 */
export async function routeInbound(phone: string): Promise<{
  contact: { id: string; campaign_id: string; full_name: string | null; company: string | null } | null;
  campaign: { id: string; name: string; client_name: string } | null;
  userId: string | null;
}> {
  const [{ data: contact }, { data: lastCall }, { data: lastSms }] = await Promise.all([
    db().from('contacts').select('id, campaign_id, full_name, company').eq('phone_e164', phone).order('last_called_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    db().from('calls').select('user_id, started_at').eq('phone_e164', phone).eq('direction', 'outbound').not('user_id', 'is', null).order('started_at', { ascending: false }).limit(1).maybeSingle(),
    db().from('sms_messages').select('user_id, created_at').eq('phone_e164', phone).eq('direction', 'outbound').not('user_id', 'is', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const last = [lastCall && { userId: lastCall.user_id as string, at: lastCall.started_at as string }, lastSms && { userId: lastSms.user_id as string, at: lastSms.created_at as string }]
    .filter((x): x is { userId: string; at: string } => !!x)
    .sort((a, b) => b.at.localeCompare(a.at))[0];

  const campaign = contact
    ? ((await db().from('campaigns').select('id, name, client_name').eq('id', contact.campaign_id).maybeSingle()).data as { id: string; name: string; client_name: string } | null)
    : null;

  return { contact: contact ?? null, campaign, userId: last?.userId ?? null };
}
