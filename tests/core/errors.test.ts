// Error taxonomy (spec-web §19). Public interface only.
import { describe, it, expect } from 'vitest'
import {
  SmartCropError, NoDocumentError, EmptySelectionError, InvalidSplitError,
  DeleteAllPagesError, MissingDependencyError, ImagingError, DocumentLoadError,
} from '@core/errors'

describe('SmartCropError taxonomy', () => {
  it('every subclass is a SmartCropError and an Error, with .name set to its own class name', () => {
    const classes = [
      NoDocumentError, EmptySelectionError, InvalidSplitError,
      DeleteAllPagesError, MissingDependencyError, ImagingError,
    ]
    for (const C of classes) {
      const e = new C('boom')
      expect(e).toBeInstanceOf(SmartCropError)
      expect(e).toBeInstanceOf(Error)
      expect(e.name).toBe(C.name)
      expect(e.message).toBe('boom')
    }
  })

  it('DocumentLoadError carries the underlying failure via the native Error.cause (M5)', () => {
    const underlying = new Error('worker rejected')
    const e = new DocumentLoadError('Failed to load the selected files', underlying)
    expect(e.cause).toBe(underlying)
    expect(e).toBeInstanceOf(SmartCropError)
  })

  it('DocumentLoadError leaves .cause unset when none is given', () => {
    const e = new DocumentLoadError('No pages to load')
    expect(e.cause).toBeUndefined()
  })
})
