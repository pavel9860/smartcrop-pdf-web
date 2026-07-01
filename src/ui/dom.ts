// dom.ts — shared DOM lookup helper. Throws instead of allowing a silent null
// (replaces the `querySelector(...)!` non-null-assertion pattern repeated across panels).

export function requireEl<E extends Element>(root: ParentNode, selector: string): E {
  const el = root.querySelector<E>(selector)
  if (!el) throw new Error(`Element not found: ${selector}`)
  return el
}
