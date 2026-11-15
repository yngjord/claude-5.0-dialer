/**
 * Puts `text` in place of the textarea's selection and leaves the cursor after it, without moving the view: the
 * textarea's own scroll and any scrolled container around it (e.g. a modal) stay exactly where they were. Plain
 * focus() + setSelectionRange() otherwise jump the script to the cursor/bottom. `setValue` is the React state setter.
 */
export function insertAtCursor(el: HTMLTextAreaElement | null, value: string, setValue: (v: string) => void, text: (before: string, after: string) => string) {
  const at = el ? el.selectionStart : value.length;
  const end = el ? el.selectionEnd : value.length;
  const token = text(value.slice(0, at), value.slice(end));
  // Remember every scroll position that the update or the refocus could change.
  const scrolled: [Element, number][] = [];
  for (let n: Element | null = el; n; n = n.parentElement) scrolled.push([n, n.scrollTop]);
  const page = window.scrollY;
  setValue(value.slice(0, at) + token + value.slice(end));
  requestAnimationFrame(() => {
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(at + token.length, at + token.length);
    for (const [n, top] of scrolled) n.scrollTop = top;
    window.scrollTo({ top: page });
  });
}
