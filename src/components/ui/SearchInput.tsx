import { Search } from 'lucide-react';

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block w-full sm:max-w-xs">
      <span className="sr-only">{placeholder}</span>
      <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-full border border-line-strong bg-white pl-11 pr-4 text-sm placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand-soft"
      />
    </label>
  );
}
