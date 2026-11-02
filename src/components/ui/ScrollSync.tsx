import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A wide table with a horizontal scrollbar above it as well as below, kept in step, so long lists can be scrolled
 * sideways without going to the bottom first. The top bar only shows when the content is wider than the box.
 */
export function ScrollSync({ children, className = '' }: { children: ReactNode; className?: string }) {
  const top = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = top.current;
    const b = body.current;
    const s = spacer.current;
    if (!t || !b || !s) return;
    const size = () => {
      s.style.width = `${b.scrollWidth}px`;
      t.style.display = b.scrollWidth > b.clientWidth + 1 ? 'block' : 'none';
    };
    size();
    const observer = new ResizeObserver(size);
    observer.observe(b);
    if (b.firstElementChild) observer.observe(b.firstElementChild);
    // Whichever one moved drives the other (the flag stops them echoing back and forth).
    let syncing = false;
    const follow = (from: HTMLDivElement, to: HTMLDivElement) => () => {
      if (syncing) return;
      syncing = true;
      to.scrollLeft = from.scrollLeft;
      requestAnimationFrame(() => (syncing = false));
    };
    const onTop = follow(t, b);
    const onBody = follow(b, t);
    t.addEventListener('scroll', onTop);
    b.addEventListener('scroll', onBody);
    return () => {
      observer.disconnect();
      t.removeEventListener('scroll', onTop);
      b.removeEventListener('scroll', onBody);
    };
  }, []);

  return (
    <>
      <div ref={top} className="-mx-4 mb-2 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-hidden>
        <div ref={spacer} className="h-px" />
      </div>
      <div ref={body} className={`relative -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 ${className}`}>
        {children}
      </div>
    </>
  );
}
