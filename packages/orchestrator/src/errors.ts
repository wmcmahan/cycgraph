/**
 * Shared base class for every error the engine throws.
 *
 * Lets consumers distinguish engine errors from arbitrary throws with a single
 * check — `catch (e) { if (e instanceof CycgraphError) … }` — instead of
 * importing and testing all ~two-dozen concrete error classes individually. A
 * new engine error type re-parented onto this is caught by existing handlers
 * automatically.
 *
 * Concrete errors still set their own `name` and may add fields; this only
 * unifies the prototype chain.
 */
export class CycgraphError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CycgraphError';
  }
}
