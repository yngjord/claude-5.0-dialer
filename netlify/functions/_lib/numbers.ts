import { twilioClient } from './twilio';

// Buying Australian mobile numbers. Twilio only sells them to accounts with an approved AU regulatory bundle, and
// each purchase must name that bundle and the address inside it (Twilio error 21651 otherwise). Both are found
// automatically; TWILIO_BUNDLE_SID / TWILIO_ADDRESS_SID override that if the account ever has several.

export const COUNTRY = 'AU';

export interface BundleState {
  /** Approved bundle to buy with, or null when there isn't one yet. */
  sid: string | null;
  /** Status of the newest AU mobile bundle (e.g. 'in-review'), to explain why buying isn't possible yet. */
  status: string | null;
}

export async function findBundle(): Promise<BundleState> {
  if (process.env.TWILIO_BUNDLE_SID) return { sid: process.env.TWILIO_BUNDLE_SID, status: 'twilio-approved' };
  const bundles = await twilioClient().numbers.v2.regulatoryCompliance.bundles.list({ isoCountry: COUNTRY, numberType: 'mobile', limit: 20 });
  const approved = bundles.find((b) => b.status === 'twilio-approved') ?? bundles.find((b) => b.status === 'provisionally-approved');
  return { sid: approved?.sid ?? null, status: approved?.status ?? bundles[0]?.status ?? null };
}

/** The address that's part of the bundle (the business address approved with it). */
export async function findBundleAddress(bundleSid: string): Promise<string | null> {
  if (process.env.TWILIO_ADDRESS_SID) return process.env.TWILIO_ADDRESS_SID;
  const compliance = twilioClient().numbers.v2.regulatoryCompliance;
  const items = await compliance.bundles(bundleSid).itemAssignments.list({ limit: 50 });
  // Attached to the bundle directly…
  const direct = items.find((i) => i.objectSid.startsWith('AD'));
  if (direct) return direct.objectSid;
  // …or, more often, named by one of its supporting documents (attributes.address_sids).
  for (const item of items.filter((i) => i.objectSid.startsWith('RD'))) {
    const doc = await compliance.supportingDocuments(item.objectSid).fetch();
    const sids = (doc.attributes as { address_sids?: string[] | string } | null)?.address_sids;
    const sid = Array.isArray(sids) ? sids[0] : sids;
    if (sid?.startsWith('AD')) return sid;
  }
  return null;
}

/** Monthly price of an AU mobile number, as Twilio charges it (usually USD). Null if Twilio doesn't say. */
export async function mobileMonthlyPrice(): Promise<{ amount: number; currency: string } | null> {
  try {
    const country = await twilioClient().pricing.v1.phoneNumbers.countries(COUNTRY).fetch();
    const mobile = country.phoneNumberPrices.find((p) => p.numberType === 'mobile');
    const amount = mobile?.currentPrice ?? mobile?.basePrice;
    return amount != null ? { amount: Number(amount), currency: country.priceUnit?.toUpperCase() || 'USD' } : null;
  } catch (err) {
    console.warn('Could not read Twilio number pricing', err);
    return null;
  }
}
