// History (ARCHITECTURE §5.3) — bounded undo/redo, direct unit tests for the branches the
// AppModel suite reaches only indirectly (empty-stack returns, depth-trim of both stacks).
import { describe, it, expect } from 'vitest'
import { History } from '@core/history'
import { default_document_state, type DocumentState } from '@core/document_state'

function st(): DocumentState { return default_document_state() }

describe('History', () => {
  it('undo/redo on empty stacks return null', () => {
    const h = new History(10)
    expect(h.undo(st())).toBeNull()          // empty undo -> null (line 29)
    expect(h.redo(st())).toBeNull()          // empty redo -> null (line 38)
    expect(h.can_undo).toBe(false)
    expect(h.can_redo).toBe(false)
  })

  it('push then undo/redo round-trips and toggles availability', () => {
    const h = new History(10)
    h.push(st())
    expect(h.can_undo).toBe(true)
    expect(h.undo(st())).not.toBeNull()
    expect(h.can_redo).toBe(true)
    expect(h.redo(st())).not.toBeNull()
    expect(h.can_undo).toBe(true)
  })

  it('set_depth trims the undo stack', () => {
    const h = new History(10)
    h.push(st()); h.push(st()); h.push(st())
    h.set_depth(1)                           // trims undo to 1 (line 14)
    h.undo(st())
    expect(h.can_undo).toBe(false)
  })

  it('set_depth trims the redo stack', () => {
    const h = new History(10)
    h.push(st()); h.push(st())
    h.undo(st()); h.undo(st())               // redo now holds 2
    expect(h.can_redo).toBe(true)
    h.set_depth(1)                           // trims redo to 1 (line 15)
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
