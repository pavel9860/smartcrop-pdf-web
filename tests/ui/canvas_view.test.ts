// CanvasView input (spec-web §20): the wheel turns pages, Ctrl/⌘+wheel is left to browser zoom, and
// no crop gesture starts while a job runs.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { CanvasView } from '@ui/canvas_view'
import type { AppModel } from '@core/model'
import { mount, loaded, stub_canvas_apis } from './harness'

async function view(busy = false): Promise<{ model: AppModel; overlay: HTMLElement; cv: CanvasView }> {
  stub_canvas_apis()
  const model = await loaded()
  const cv = new CanvasView(model, () => busy)
  mount().appendChild(cv.el)
  cv.paint(model.view_snapshot())
  return { model, cv, overlay: document.querySelector<HTMLElement>('.overlay-canvas')! }
}

describe('CanvasView', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('wheel down/up turns pages; Ctrl+wheel and Meta+wheel do not', async () => {
    const { model, overlay } = await view()
    const positions: number[] = []
    for (const init of [{ deltaY: 100 }, { deltaY: 100, ctrlKey: true }, { deltaY: 100, metaKey: true }, { deltaY: 100 }, { deltaY: -100 }]) {
      overlay.dispatchEvent(new WheelEvent('wheel', init))
      positions.push(model.view_position)
    }
    expect(positions).toEqual([2, 2, 2, 3, 2])
  })

  it('a press starts a crop gesture, except while a job runs', async () => {
    for (const busy of [false, true]) {
      const { model, overlay, cv } = await view(busy)
      const begin = vi.spyOn(model, 'begin_drag')
      overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      expect(begin).toHaveBeenCalledTimes(busy ? 0 : 1)
      cv.destroy()
    }
  })
})
