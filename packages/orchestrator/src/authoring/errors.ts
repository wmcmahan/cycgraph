/**
 * Authoring facade errors.
 *
 * @module authoring/errors
 */

/** Thrown when the graph shape can't be resolved (dup ids, ambiguous start/end, interface violations). */
export class GraphSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphSpecError';
  }
}
