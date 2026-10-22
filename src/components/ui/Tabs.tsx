export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-full border border-line-strong bg-white p-1">
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            className={`inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full px-4 font-medium text-[14px] transition-colors sm:px-5 ${
              active ? 'bg-brand text-white' : 'text-ink-soft hover:text-brand'
            }`}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className={`text-[12px] tabular-nums ${active ? 'text-white/75' : 'text-ink-faint'}`}>{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
