export default function Splash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-white" role="status" aria-label="Loading">
      <img src="/maronly-mark.png" alt="" className="h-16 w-16" />
      <div className="h-1 w-48 overflow-hidden rounded-full bg-neutral-200">
        <div className="h-full w-1/3 animate-loading-bar rounded-full bg-brand" />
      </div>
    </div>
  );
}
