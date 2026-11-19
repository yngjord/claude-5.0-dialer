import type { Disposition } from './constants';

/** Twilio's reason a call never reached the prospect (from the status webhook), in words a rep can act on. */
export interface CarrierFailure {
  message: string;
  /** The disposition that fits, pre-selected in the wrap-up form. */
  disposition: Disposition;
}

interface FailedRow {
  twilio_status: string | null;
  twilio_error_code?: number | null;
  sip_response_code?: number | null;
}

/**
 * Why the phone network refused the call, or null if it didn't. Twilio ends the browser's side of a refused call with
 * a generic connection error, so without this the rep is told to check their internet when the number is the problem.
 * Codes: https://www.twilio.com/docs/api/errors (132xx) and SIP response codes.
 */
export function carrierFailure(row: FailedRow | null | undefined): CarrierFailure | null {
  if (!row || (row.twilio_status !== 'failed' && row.twilio_status !== 'busy')) return null;
  const code = row.twilio_error_code ?? null;
  const sip = row.sip_response_code ?? null;
  if (row.twilio_status === 'busy' || sip === 486 || sip === 600) return { message: 'The line was busy.', disposition: 'No Answer' };
  if (code === 13223 || code === 13224 || sip === 404 || sip === 484 || sip === 410)
    return { message: "This number isn't connected: the phone network says it doesn't exist.", disposition: 'Disconnected Number' };
  if (sip === 480) return { message: "The phone is switched off or out of range, so the call couldn't go through.", disposition: 'No Answer' };
  if (sip === 603) return { message: 'The call was declined straight away.', disposition: 'No Answer' };
  if (code === 13227) return { message: "Calls to this country aren't allowed on our phone account.", disposition: 'No Answer' };
  return {
    message: `The phone network couldn't connect the call${code || sip ? ` (${[code && `error ${code}`, sip && `SIP ${sip}`].filter(Boolean).join(', ')})` : ''}. Try again later.`,
    disposition: 'No Answer',
  };
}
