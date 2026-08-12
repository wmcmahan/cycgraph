/**
 * @cycgraph/a2a — official Agent2Agent adapter for the orchestrator.
 *
 * The engine owns the `A2AClient` port; this package implements it on
 * `@a2a-js/sdk`, so orchestrator core carries no protocol dependency.
 *
 * @module index
 */

export { createA2AClient } from './client.js';
export type { A2AClientOptions } from './client.js';
export type { CreateSdkClient } from './connection.js';
export { normalizeState } from './task-state.js';
export { partsToValue, toResult } from './translate.js';
