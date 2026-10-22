import { AlertCircle } from 'lucide-react';
import { Spinner } from './Spinner';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex animate-appear flex-col gap-4 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="font-display text-[30px] font-normal leading-tight sm:text-[40px]">{title}</h1>
        {subtitle && <p className="mt-2 text-[15px] text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingRows({ rows = 6, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true">
      <div className="mb-4 flex items-center gap-2 text-sm text-ink-muted">
        <Spinner size={14} className="text-brand" />
        {label}
      </div>
      <div className="divide-y divide-line border-t border-line">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-6 py-4" style={{ opacity: 1 - i * 0.12 }}>
            <div className="skeleton h-4 w-[34%]" />
            <div className="skeleton h-5 w-16 rounded-full" />
            <div className="skeleton h-4 w-20" />
            <div className="skeleton ml-auto h-4 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-14 text-center">
      <AlertCircle className="text-red-500" size={28} />
      <p className="text-sm text-ink-muted">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="font-medium text-sm text-brand hover:underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-14 text-center text-sm text-ink-faint">
        {children}
      </td>
    </tr>
  );
}
