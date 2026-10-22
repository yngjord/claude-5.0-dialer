// Comfortaa is reserved for the "maronly" wordmark — use font-body/font-display everywhere else.
export default function Brand({ size = 'md', tone = 'dark' }: { size?: 'md' | 'lg'; tone?: 'dark' | 'light' }) {
  const lg = size === 'lg';
  const light = tone === 'light';
  return (
    <span className={`inline-flex items-center font-brand tracking-[-0.2px] ${light ? 'text-white' : 'text-ink'} ${lg ? 'gap-3 text-[34px]' : 'gap-2.5 text-[28px]'}`}>
      maronly
      <img src="/maronly-mark.png" alt="" className={`${lg ? 'h-11 w-11' : 'h-9 w-9'} ${light ? 'brightness-0 invert' : ''}`} />
    </span>
  );
}
