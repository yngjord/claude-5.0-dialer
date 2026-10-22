import { useIsLoading } from '../lib/activity';

/** Thin indeterminate bar pinned to the top of the viewport while any API request is in flight. */
export default function LoadingBar() {
  const loading = useIsLoading();
  return (
    <div
      role="progressbar"
      aria-label="Loading data"
      aria-hidden={!loading}
      className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] overflow-hidden transition-opacity duration-300 ${loading ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className="h-full w-1/3 animate-loading-bar rounded-full bg-brand" />
    </div>
  );
}
