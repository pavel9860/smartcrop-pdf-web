// dom.ts — shared DOM lookup helper. Throws instead of allowing a silent null
// (replaces the `querySelector(...)!` non-null-assertion pattern repeated across panels).

export function requireEl<E extends Element>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}

// Reveal a numeric "Custom…" field exactly when its paired <select> has the sentinel value
// selected, and keep it synced with the model value while shown (never overwriting an in-
// progress edit). Shared by the sidebar Output Quality card (Custom DPI) and Settings -> Output
// (Custom paper height) so the reveal/sync logic isn't duplicated per field. `reveal` is the
// element whose `hidden` attribute toggles — the input itself for a bare field, or a wrapping
// row when the input has an adjacent label that must hide/show with it.
export function syncCustomReveal(
  select: HTMLSelectElement, reveal: HTMLElement, input: HTMLInputElement,
  sentinel: string, value: string,
): void {
  const active = select.value === sentinel
  reveal.hidden = !active
  if (active && document.activeElement !== input) input.value = value
}
