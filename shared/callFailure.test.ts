import { describe, expect, it } from 'vitest';
import { carrierFailure } from './callFailure';

describe('carrierFailure', () => {
  it('is null unless the call failed or was busy', () => {
    expect(carrierFailure(null)).toBeNull();
    expect(carrierFailure({ twilio_status: 'completed', sip_response_code: 404 })).toBeNull();
  });
  it('calls a number the network says does not exist disconnected', () => {
    expect(carrierFailure({ twilio_status: 'failed', twilio_error_code: 13224, sip_response_code: 404 })?.disposition).toBe('Disconnected Number');
    expect(carrierFailure({ twilio_status: 'failed', sip_response_code: 484 })?.disposition).toBe('Disconnected Number');
  });
  it('treats busy, switched off and unknown failures as No Answer', () => {
    expect(carrierFailure({ twilio_status: 'busy' })).toEqual({ message: 'The line was busy.', disposition: 'No Answer' });
    expect(carrierFailure({ twilio_status: 'failed', sip_response_code: 480 })?.message).toMatch(/switched off/);
    expect(carrierFailure({ twilio_status: 'failed', twilio_error_code: 32011 })?.message).toMatch(/error 32011/);
    expect(carrierFailure({ twilio_status: 'failed' })?.disposition).toBe('No Answer');
  });
});
