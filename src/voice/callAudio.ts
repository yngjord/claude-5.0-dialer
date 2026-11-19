import type { Call, Device } from '@twilio/voice-sdk';
import { supabase } from '../lib/supabase';

/** What a call sounded like from the rep's browser, saved on the call for diagnosing audio delays. */
export interface CallAudioReport {
  /** ms from the prospect answering to the first sound from them reaching the rep's speaker (null: never heard). */
  heard_ms: number | null;
  /** ms from the prospect answering to the rep's microphone first picking up their voice. */
  spoke_ms: number | null;
  /** Twilio's call quality warnings during the call (e.g. high-rtt, high-packet-loss, low-mos). */
  warnings: string[];
  mic: string | null;
  speaker: string | null;
  browser: string;
  edge: string | null;
}

// Volume levels (0–1) that count as sound rather than line noise.
const HEARD = 0.02;
const SPOKE = 0.05;

function browserName(): string {
  const ua = navigator.userAgent;
  const m = ua.match(/Edg\/(\d+)/) ?? ua.match(/OPR\/(\d+)/) ?? ua.match(/Firefox\/(\d+)/) ?? ua.match(/Chrome\/(\d+)/) ?? ua.match(/Version\/(\d+).*Safari/);
  const name = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${name}${m ? ` ${m[1]}` : ''}${os ? ` on ${os}` : ''}`;
}

/**
 * Watches one call: how long after the answer the rep first hears the prospect, and first speaks, plus Twilio's
 * quality warnings and the audio devices in use. Sent to the server when the call ends (answered calls only).
 */
export function watchCallAudio(call: Call, device: Device, callId: string): void {
  let answeredAt: number | null = null;
  let heard: number | null = null;
  let spoke: number | null = null;
  const warnings = new Set<string>();
  call.on('accept', () => (answeredAt = performance.now()));
  call.on('volume', (input: number, output: number) => {
    if (answeredAt == null) return;
    const t = Math.round(performance.now() - answeredAt);
    if (heard == null && output > HEARD) heard = t;
    if (spoke == null && input > SPOKE) spoke = t;
  });
  call.on('warning', (name: string) => warnings.size < 12 && warnings.add(name));
  const send = () => {
    if (answeredAt == null) return;
    const speakers = [...(device.audio?.speakerDevices.get() ?? [])];
    const report: CallAudioReport = {
      heard_ms: heard,
      spoke_ms: spoke,
      warnings: [...warnings],
      mic: device.audio?.inputDevice?.label || null,
      speaker: speakers[0]?.label || null,
      browser: browserName(),
      edge: device.edge ?? null,
    };
    void supabase.auth.getSession().then(({ data }) =>
      fetch('/api/call-audio', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session?.access_token ?? ''}` },
        body: JSON.stringify({ callId, report }),
      }).catch(() => undefined),
    );
  };
  call.on('disconnect', send);
}
