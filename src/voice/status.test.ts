import { describe, expect, it } from 'vitest';
import type { ActiveCall } from './VoiceProvider';
import { callStatusLabel } from './status';

const call = (over: Partial<ActiveCall>): ActiveCall =>
  ({ callId: 'c', mode: 'power', phase: 'live', muted: false, answeredAt: 1, row: null, error: null, ...over }) as ActiveCall;

describe('callStatusLabel', () => {
  it('shows a connected call as connected', () => {
    expect(callStatusLabel(call({}))).toEqual({ label: 'Connected', tone: 'live' });
  });

  it('flags a weak connection while Twilio warns about the network', () => {
    expect(callStatusLabel(call({ weakConnection: true }))).toEqual({ label: 'Connected · weak internet connection', tone: 'warn' });
  });

  it('prefers reconnecting over a weak connection', () => {
    expect(callStatusLabel(call({ weakConnection: true, reconnecting: true })).label).toBe('Connection dropped, reconnecting…');
  });

  it('ignores the weak connection flag before the answer', () => {
    expect(callStatusLabel(call({ phase: 'ringing', answeredAt: null, weakConnection: true })).label).toBe('Connecting…');
  });
});
