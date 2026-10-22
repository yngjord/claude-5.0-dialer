import { Call, Device } from '@twilio/voice-sdk';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CallRow, Campaign, Contact } from '../../shared/types';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';

export type CallPhase = 'connecting' | 'ringing' | 'live' | 'ended';
export type DeviceState = 'off' | 'starting' | 'ready' | 'error';

export interface ActiveCall {
  callId: string;
  contact: Contact;
  campaign: Campaign;
  /** 'power' calls are wrapped up on the Dialer page; 'click' calls get the wrap-up popup. */
  mode: 'power' | 'click';
  phase: CallPhase;
  muted: boolean;
  /** When the prospect answered (ms), for the call timer. */
  answeredAt: number | null;
  /** The call's row in Supabase, kept live (Twilio status, AMD, pickup status). */
  row: CallRow | null;
  error: string | null;
}

interface VoiceContextValue {
  deviceState: DeviceState;
  deviceError: string | null;
  active: ActiveCall | null;
  /** Creates the Twilio device if needed (asks for the microphone). */
  start: () => Promise<void>;
  dial: (contact: Contact, campaign: Campaign, mode: ActiveCall['mode']) => Promise<void>;
  hangUp: () => void;
  toggleMute: () => void;
  sendDigits: (digits: string) => void;
  /** Forget the finished call (after wrap-up). */
  clear: () => void;
}

const VoiceContext = createContext<VoiceContextValue | null>(null);

const fetchToken = () => api<{ token: string }>('voice-token').then((r) => r.token);

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [deviceState, setDeviceState] = useState<DeviceState>('off');
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [active, setActive] = useState<ActiveCall | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);
  const startingRef = useRef<Promise<void> | null>(null);

  const patch = useCallback((callId: string, p: Partial<ActiveCall>) => {
    setActive((a) => (a && a.callId === callId ? { ...a, ...p } : a));
  }, []);

  const start = useCallback(async () => {
    if (deviceRef.current) return;
    if (startingRef.current) return startingRef.current;
    startingRef.current = (async () => {
      setDeviceState('starting');
      setDeviceError(null);
      try {
        // Ask for the mic up front so the first call doesn't stall on the permission prompt.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());

        const device = new Device(await fetchToken(), {
          edge: ['sydney', 'roaming'],
          codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
          closeProtection: 'You are on a call. Leaving will hang up.',
          logLevel: 'error',
        });
        device.on('tokenWillExpire', async () => device.updateToken(await fetchToken()));
        device.on('error', (err: { message?: string }) => setDeviceError(err.message ?? 'Phone connection error'));
        deviceRef.current = device;
        setDeviceState('ready');
      } catch (err) {
        setDeviceState('error');
        setDeviceError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Microphone access is blocked. Allow it in your browser settings, then try again.'
            : err instanceof Error
              ? err.message
              : 'Could not start the phone.',
        );
        throw err;
      } finally {
        startingRef.current = null;
      }
    })();
    return startingRef.current;
  }, []);

  const dial = useCallback(
    async (contact: Contact, campaign: Campaign, mode: ActiveCall['mode']) => {
      if (callRef.current) throw new Error('You are already on a call.');
      await start();
      const device = deviceRef.current!;
      const callId = crypto.randomUUID();
      setActive({ callId, contact, campaign, mode, phase: 'connecting', muted: false, answeredAt: null, row: null, error: null });

      try {
        const call = await device.connect({ params: { callId, contactId: contact.id } });
        callRef.current = call;
        call.on('ringing', () => patch(callId, { phase: 'ringing' }));
        call.on('accept', () => patch(callId, { phase: 'live', answeredAt: Date.now() }));
        call.on('mute', (muted: boolean) => patch(callId, { muted }));
        const end = () => {
          callRef.current = null;
          patch(callId, { phase: 'ended' });
        };
        call.on('disconnect', end);
        call.on('cancel', end);
        call.on('reject', end);
        call.on('error', (err: { message?: string }) => {
          patch(callId, { error: err.message ?? 'Call error' });
          end();
        });
      } catch (err) {
        callRef.current = null;
        patch(callId, { phase: 'ended', error: err instanceof Error ? err.message : 'The call could not be started.' });
      }
    },
    [patch, start],
  );

  // Keep the active call's Supabase row live: Twilio status, AMD and pickup status arrive via webhooks.
  const callId = active?.callId;
  useEffect(() => {
    if (!callId) return;
    let cancelled = false;
    const refresh = async () => {
      const { data } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
      if (!cancelled && data) patch(callId, { row: data as CallRow });
    };
    const channel = supabase
      .channel(`call-${callId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, (payload) => {
        if (payload.new && 'id' in payload.new) patch(callId, { row: payload.new as CallRow });
      })
      .subscribe();
    // Realtime can miss the first events while subscribing, so also poll briefly.
    const timers = [1500, 4000, 8000, 15000].map((ms) => setTimeout(refresh, ms));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      supabase.removeChannel(channel);
    };
  }, [callId, patch]);

  // After hang-up, fetch the final row a few times so pickup status is filled in for the wrap-up form.
  const ended = active?.phase === 'ended';
  useEffect(() => {
    if (!callId || !ended) return;
    const timers = [500, 2000, 5000].map((ms) =>
      setTimeout(async () => {
        const { data } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle();
        if (data) patch(callId, { row: data as CallRow });
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  }, [callId, ended, patch]);

  const hangUp = useCallback(() => callRef.current?.disconnect(), []);
  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (call) call.mute(!call.isMuted());
  }, []);
  const sendDigits = useCallback((digits: string) => callRef.current?.sendDigits(digits), []);
  const clear = useCallback(() => setActive((a) => (a?.phase === 'ended' ? null : a)), []);

  useEffect(() => () => deviceRef.current?.destroy(), []);

  return (
    <VoiceContext.Provider value={{ deviceState, deviceError, active, start, dial, hangUp, toggleMute, sendDigits, clear }}>
      {children}
    </VoiceContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useVoice() {
  const ctx = useContext(VoiceContext);
  if (!ctx) throw new Error('useVoice must be used inside VoiceProvider');
  return ctx;
}
