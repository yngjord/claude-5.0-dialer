/**
 * The Australian ring tone (400 + 450 Hz, ring-ring then a 2s pause), played in the browser while a call is being
 * placed, so the rep can hear that it's dialing. Twilio passes no audio until the prospect answers.
 */
export function startRingback(): () => void {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return () => undefined;
  }
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);
  const oscillators = [400, 450].map((hz) => {
    const o = ctx.createOscillator();
    o.frequency.value = hz;
    o.connect(gain);
    o.start();
    return o;
  });

  // One 3s cycle: on 0.4s, off 0.2s, on 0.4s, off 2s. Scheduled a minute ahead; calls ring for 30s at most.
  const level = 0.06;
  const t0 = ctx.currentTime + 0.05;
  for (let cycle = 0; cycle < 20; cycle++) {
    const t = t0 + cycle * 3;
    for (const [on, off] of [
      [0, 0.4],
      [0.6, 1.0],
    ]) {
      gain.gain.setValueAtTime(level, t + on);
      gain.gain.setValueAtTime(0, t + off);
    }
  }

  return () => {
    oscillators.forEach((o) => o.stop());
    ctx.close().catch(() => undefined);
  };
}

// Twilio's own "outgoing" chime (the SDK plays it when a call is answered; we turn that off and play it on dial).
const DIAL_CHIME = 'https://sdk.twilio.com/js/client/sounds/releases/1.0.0/outgoing.mp3';
let chime: HTMLAudioElement | null = null;

/** Plays the dial chime the moment a call is started, so the rep knows it's dialing. */
export function playDialChime(): void {
  try {
    chime ??= new Audio(DIAL_CHIME);
    chime.currentTime = 0;
    void chime.play().catch(() => undefined);
  } catch {
    // no audio available: dialing works without it
  }
}
