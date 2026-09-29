// First-use module loading status (spec-web §11): OpenCV init and model download/compile report a
// human-readable line while pending; the UI shows the latest one, or nothing (null) when idle.
type Listener = (status: string | null) => void

const listeners = new Set<Listener>()
const pending = new Map<number, string>()
let next_id = 0

function emit(): void {
  const latest = [...pending.values()].pop() ?? null
  for (const l of listeners) l(latest)
}

export function on_module_status(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Runs `run` with `label` reported while it is pending; `run` may refine the label (e.g. MB done).
export async function with_module_status<T>(
  label: string, run: (update: (label: string) => void) => Promise<T>,
): Promise<T> {
  const id = next_id++
  const update = (l: string): void => { pending.set(id, l); emit() }
  update(label)
  try {
    return await run(update)
  } finally {
    pending.delete(id)
    emit()
  }
}
