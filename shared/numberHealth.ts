/** A number's recent and baseline dials (dialer_number_reputation). */
export interface NumberReputation {
  number_id: string;
  recent_dials: number;
  recent_human: number;
  baseline_dials: number;
  baseline_human: number;
  last_dial_at: string | null;
}

/** Recent window and the most of its own history a number is compared with (keep in step with the SQL). */
export const RECENT_DIALS = 80;
/** Fewer baseline dials than this and there's nothing reliable to compare with. */
export const MIN_BASELINE = 150;
/** Flag when the recent human pickup rate is at least this much below the number's own baseline… */
export const MIN_DROP = 0.35;
/** …and the drop is unlikely to be chance: one-sided two-proportion z-test at ~95% confidence. */
export const MAX_Z = -1.65;

export interface ReputationCheck {
  alert: boolean;
  /** No verdict yet: the number hasn't made enough calls. */
  tooEarly: boolean;
  recentRate: number | null;
  baselineRate: number | null;
  /** Relative drop, e.g. 0.48 = 48% fewer human pickups than usual. Negative = better than usual. */
  drop: number | null;
  z: number | null;
}

/**
 * Whether a number looks like it's being flagged as spam: its human pickup rate over the last 80 dials is 35%+
 * below its own baseline (the 400 dials before), and the gap is too big to be chance. Each client has its own
 * number and audiences differ a lot, so a number is only compared with itself.
 */
export function checkReputation(r: Pick<NumberReputation, 'recent_dials' | 'recent_human' | 'baseline_dials' | 'baseline_human'>): ReputationCheck {
  const tooEarly = r.recent_dials < RECENT_DIALS || r.baseline_dials < MIN_BASELINE;
  if (tooEarly || r.baseline_human === 0) return { alert: false, tooEarly, recentRate: null, baselineRate: null, drop: null, z: null };
  const p1 = r.recent_human / r.recent_dials;
  const p0 = r.baseline_human / r.baseline_dials;
  const pooled = (r.recent_human + r.baseline_human) / (r.recent_dials + r.baseline_dials);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / r.recent_dials + 1 / r.baseline_dials));
  const z = se > 0 ? (p1 - p0) / se : 0;
  const drop = 1 - p1 / p0;
  return { alert: drop >= MIN_DROP && z <= MAX_Z, tooEarly: false, recentRate: p1, baselineRate: p0, drop, z };
}
