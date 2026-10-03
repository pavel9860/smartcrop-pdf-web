// Shared by the perf suite: a real-scan page size and a warm-up-then-mean timer.
export const PAGE_W = 1240
export const PAGE_H = 1755

export function bench(fn: () => void, iters: number): number {
  for (let i = 0; i < 2; i++) fn()
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  return (performance.now() - t0) / iters
}
