// Page-selection parsing (spec §11).
// resolve_pages() is the single entry point; all other functions are implementation detail.

import { PagesMode } from './enums'

// Returns a sorted, deduplicated array of 0-based page indices.
export function resolve_pages(
  mode: PagesMode,
  total: number,
  pattern: string,
): number[] {
  switch (mode) {
    case PagesMode.ALL:    return iota(total)
    case PagesMode.ODD:    return iota(total).filter(i => i % 2 === 0)   // 1,3,5 → 0,2,4
    case PagesMode.EVEN:   return iota(total).filter(i => i % 2 === 1)   // 2,4,6 → 1,3,5
    case PagesMode.SELECT: return parse_pattern(pattern, total)
  }
}

function iota(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

// Parse a mixed pattern like "1,3,5-9,1:4,::2,10:" (spec §11).
// 1-indexed inclusive on input; output is 0-indexed.
function parse_pattern(pattern: string, total: number): number[] {
  const out = new Set<number>()
  for (const part of pattern.split(',')) {
    const t = part.trim()
    if (!t) continue
    if (t.includes(':')) {
      parse_slice(t, total, out)
    } else if (t.includes('-')) {
      parse_range(t, total, out)
    } else {
      const n = parseInt(t, 10)
      if (!isNaN(n) && n >= 1 && n <= total) out.add(n - 1)
    }
  }
  return [...out].sort((a, b) => a - b)
}

// "a-b" inclusive range (1-indexed)
function parse_range(s: string, total: number, out: Set<number>): void {
  const parts = s.split('-')
  if (parts.length !== 2) return
  const a = parseInt(parts[0] ?? '', 10)
  const b = parseInt(parts[1] ?? '', 10)
  if (isNaN(a) || isNaN(b)) return
  for (let p = Math.max(1, a); p <= Math.min(total, b); p++) out.add(p - 1)
}

// "start:stop[:step]" — 1-indexed inclusive (spec §11):
//   "1:4"      == pages 1,2,3,4
//   "1:100:5"  == 1,6,11,...,96
//   "::2"      == every odd page (1,3,5,...)
//   "10:"      == page 10 to end
function parse_slice(s: string, total: number, out: Set<number>): void {
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 3) return

  const start_s = (parts[0] ?? '').trim()
  const stop_s  = (parts[1] ?? '').trim()
  const step_s  = (parts[2] ?? '').trim()

  const start = start_s === '' ? 1      : parseInt(start_s, 10)
  const stop  = stop_s  === '' ? total  : parseInt(stop_s,  10)
  const step  = step_s  === '' ? 1      : parseInt(step_s,  10)

  if (isNaN(start) || isNaN(stop) || isNaN(step) || step <= 0) return

  // Seed at max(1, start), matching parse_range: an unbounded-looking negative start (e.g.
  // "-999999999:5") must not iterate from there up to 1 one step at a time (H4 — froze the tab).
  for (let p = Math.max(1, start); p <= Math.min(stop, total); p += step) {
    out.add(p - 1)
  }
}
