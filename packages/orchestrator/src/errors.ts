/**
 * Shared base class for every error the engine throws.
 */
export class CycgraphError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CycgraphError';
  }
}
