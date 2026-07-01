// History — bounded undo/redo of DocumentState snapshots (ARCHITECTURE §5.3).

import { type DocumentState, snapshot } from './document_state'

export class History {
  private _undo: DocumentState[] = []
  private _redo: DocumentState[] = []
  private _depth: number

  constructor(depth: number) { this._depth = depth }

  set_depth(depth: number): void {
    this._depth = depth
    while (this._undo.length > depth) this._undo.shift()
    while (this._redo.length > depth) this._redo.shift()
  }

  // Store a pre-mutation snapshot of state, clear redo stack.
  push(state: DocumentState): void {
    this._undo.push(snapshot(state))
    if (this._undo.length > this._depth) this._undo.shift()
    this._redo = []
  }

  // Pop the most recent undo snapshot; push a snapshot of current to redo.
  // Returns null if the undo stack is empty.
  undo(current: DocumentState): DocumentState | null {
    const prev = this._undo.pop()
    if (prev === undefined) return null
    this._redo.push(snapshot(current))
    return prev
  }

  // Pop the most recent redo snapshot; push a snapshot of current to undo.
  // Returns null if the redo stack is empty.
  redo(current: DocumentState): DocumentState | null {
    const next = this._redo.pop()
    if (next === undefined) return null
    this._undo.push(snapshot(current))
    return next
  }

  get can_undo(): boolean { return this._undo.length > 0 }
  get can_redo(): boolean { return this._redo.length > 0 }

  clear(): void { this._undo = []; this._redo = [] }
}
