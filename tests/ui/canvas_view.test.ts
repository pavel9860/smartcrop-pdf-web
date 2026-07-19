// CanvasView.wheel tests — acceptance invariant (spec-web §20): the wheel turns pages, and
// Ctrl/⌘+wheel is left alone for the browser's own zoom, never intercepted as page-navigate.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { CanvasView } from '@ui/canvas_view'
import { mount, make_model, stub_canvas_apis } from './harness'

describe('CanvasView wheel handling', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('deltaY > 0 advances to the next page', async () => {
    const root = mount()
    stub_canvas_apis()
    const model = await make_model({ page_count: 3 })
    const cv = new CanvasView(model)
    root.appendChild(cv.el)
    cv.paint(model.view_snapshot())
    const overlay = root.querySelector<HTMLElement>('.overlay-canvas')!

    expect(model.view_position).toBe(1)
    overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
    expect(model.view_position).toBe(2)
  })

  it('deltaY < 0 goes to the previous page', async () => {
    const root = mount()
    stub_canvas_apis()
    const model = await make_model({ page_count: 3 })
    model.next_page()
    const cv = new CanvasView(model)
    root.appendChild(cv.el)
    cv.paint(model.view_snapshot())
    const overlay = root.querySelector<HTMLElement>('.overlay-canvas')!

    expect(model.view_position).toBe(2)
    overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
    expect(model.view_position).toBe(1)
  })

  it('Ctrl+wheel and Meta+wheel are left alone for browser zoom — no page change', async () => {
    const root = mount()
    stub_canvas_apis()
    const model = await make_model({ page_count: 3 })
    const cv = new CanvasView(model)
    root.appendChild(cv.el)
    cv.paint(model.view_snapshot())
    const overlay = root.querySelector<HTMLElement>('.overlay-canvas')!

    overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true }))
    expect(model.view_position).toBe(1)
    overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, metaKey: true }))
    expect(model.view_position).toBe(1)
  })
})
