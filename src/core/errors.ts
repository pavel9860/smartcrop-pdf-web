// Typed error taxonomy (spec §20, ARCHITECTURE §6).
// core/ raises these; ui/ catches them in dispatch() / dispatch_job() only.

export class SmartCropError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = this.constructor.name
  }
}

export class NoDocumentError extends SmartCropError {}
export class EmptySelectionError extends SmartCropError {}
export class InvalidSplitError extends SmartCropError {}
export class DeleteAllPagesError extends SmartCropError {}
export class MissingDependencyError extends SmartCropError {}
export class ImagingError extends SmartCropError {}

export class DocumentLoadError extends SmartCropError {
  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined)
  }
}
