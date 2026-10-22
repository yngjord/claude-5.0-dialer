export type Tone = 'green' | 'greenSolid' | 'red' | 'redSolid' | 'orange' | 'blue' | 'sky' | 'amber' | 'purple' | 'grey' | 'dark';

const tones: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  greenSolid: 'bg-emerald-700 text-white ring-emerald-800/30',
  orange: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  sky: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  redSolid: 'bg-red-600 text-white ring-red-700/30',
  blue: 'bg-brand-tint text-brand ring-brand/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  purple: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  grey: 'bg-neutral-100 text-neutral-600 ring-neutral-500/20',
  dark: 'bg-neutral-200 text-neutral-800 ring-neutral-600/25',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}>
      {children}
    </span>
  );
}
