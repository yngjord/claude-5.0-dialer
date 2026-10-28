import { useCallback, useEffect, useState } from 'react';

// The rep's chosen microphone and speaker, remembered in this browser. Empty = the computer's default.
const MIC_KEY = 'dialer.audio.mic';
const SPEAKER_KEY = 'dialer.audio.speaker';
const CHANGED = 'dialer:audio-devices';

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function write(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // storage blocked: the choice lasts until the page reloads
  }
  window.dispatchEvent(new Event(CHANGED));
}

export const chosenMicId = () => read(MIC_KEY);
export const chosenSpeakerId = () => read(SPEAKER_KEY);

/** Whether this browser can send audio to a chosen speaker (Chrome and Edge can; Safari and Firefox can't). */
export const canPickSpeaker = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/** Routes an <audio> element (dial chime, test sound) to the chosen speaker where the browser allows it. */
export async function routeToSpeaker(el: HTMLMediaElement): Promise<void> {
  const id = chosenSpeakerId();
  if (!canPickSpeaker) return;
  await (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(id).catch(() => undefined);
}

/** Routes an AudioContext (the ring tone) to the chosen speaker where the browser allows it. */
export async function routeContextToSpeaker(ctx: AudioContext): Promise<void> {
  const id = chosenSpeakerId();
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (id && c.setSinkId) await c.setSinkId(id).catch(() => undefined);
}

/** Runs `fn` whenever the rep picks a different microphone or speaker. */
export function onAudioDevicesChanged(fn: () => void): () => void {
  window.addEventListener(CHANGED, fn);
  return () => window.removeEventListener(CHANGED, fn);
}

export interface AudioDevices {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  /** Device labels are hidden until the browser has been given microphone access (turning on the phone does it). */
  labelled: boolean;
  micId: string;
  speakerId: string;
  setMic: (id: string) => void;
  setSpeaker: (id: string) => void;
  /** Label of the device in use: the chosen one, else the system default. */
  micLabel: string;
  speakerLabel: string;
}

const real = (d: MediaDeviceInfo) => d.deviceId !== 'default' && d.deviceId !== 'communications';
// Chrome lists the system default as "Default - MacBook Pro Microphone": show just the device.
const clean = (label: string) => label.replace(/^(Default|Communications) - /, '');

function labelFor(list: MediaDeviceInfo[], id: string, fallback: string): string {
  const chosen = id && list.find((d) => d.deviceId === id);
  if (chosen) return clean(chosen.label) || fallback;
  const def = list.find((d) => d.deviceId === 'default') ?? list[0];
  return def?.label ? clean(def.label) : fallback;
}

/** The computer's microphones and speakers, kept up to date as headsets are plugged in or out. */
export function useAudioDevices(refreshKey?: unknown): AudioDevices {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(chosenMicId);
  const [speakerId, setSpeakerId] = useState(chosenSpeakerId);

  const load = useCallback(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    load();
    navigator.mediaDevices?.addEventListener('devicechange', load);
    const off = onAudioDevicesChanged(() => {
      setMicId(chosenMicId());
      setSpeakerId(chosenSpeakerId());
    });
    return () => {
      navigator.mediaDevices?.removeEventListener('devicechange', load);
      off();
    };
  }, [load, refreshKey]);

  const allMics = devices.filter((d) => d.kind === 'audioinput');
  const allSpeakers = devices.filter((d) => d.kind === 'audiooutput');
  // A remembered device that's been unplugged falls back to the default.
  const mic = allMics.some((d) => d.deviceId === micId) ? micId : '';
  const speaker = allSpeakers.some((d) => d.deviceId === speakerId) ? speakerId : '';

  return {
    mics: allMics.filter(real),
    speakers: allSpeakers.filter(real),
    labelled: allMics.some((d) => !!d.label),
    micId: mic,
    speakerId: speaker,
    setMic: (id) => write(MIC_KEY, id),
    setSpeaker: (id) => write(SPEAKER_KEY, id),
    micLabel: labelFor(allMics, mic, 'Default microphone'),
    speakerLabel: labelFor(allSpeakers, speaker, 'Default speaker'),
  };
}
