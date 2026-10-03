// History (ARCHITECTURE §5.3) — bounded undo/redo: empty-stack returns, depth-trim of both stacks.
import { describe, it, expect } from 'vitest'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'

function st(): DocumentState { return default_document_state() }

describe('History', () => {
  it('undo/redo on empty stacks return null', () => {
    const h = new History(10)
    expect(h.undo(st())).toBeNull()
    expect(h.redo(st())).toBeNull()
    expect(h.can_undo).toBe(false)
    expect(h.can_redo).toBe(false)
  })

  it('push snapshots by value; undo and redo hand back the saved states', () => {
    const h = new History(10)
    const a = st(), b = st(), c = st()
    a.filter_strength = 1; b.filter_strength = 2; c.filter_strength = 3
    h.push(a)
    a.filter_strength = 9
    expect(h.undo(b)?.filter_strength).toBe(1)
    expect(h.redo(c)?.filter_strength).toBe(2)
    expect([h.can_undo, h.can_redo]).toEqual([true, false])
  })

  it('set_depth trims the undo stack', () => {
    const h = new History(10)
    h.push(st()); h.push(st()); h.push(st())
    h.set_depth(1)
    h.undo(st())
    expect(h.can_undo).toBe(false)
  })

  it('set_depth trims the redo stack', () => {
    const h = new History(10)
    h.push(st()); h.push(st())
    h.undo(st()); h.undo(st())               // redo now holds 2
    expect(h.can_redo).toBe(true)
    h.set_depth(1)
    h.redo(st())
    expect(h.can_redo).toBe(false)
  })

  it('clear empties both stacks', () => {
    const h = new History(10)
    h.push(st())
    h.clear()
    expect(h.can_undo).toBe(false)
    expect(h.can_redo).toBe(false)
  })
})
