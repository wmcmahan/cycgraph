/**
 * The scoped scan the scan and judge tools share.
 *
 * Scan and judge must look through the same scope: an out-of-scope finding
 * the scan never reported would otherwise be counted by the judge's
 * re-scan as newly introduced. So both call this one helper, which applies
 * the scenario scope and the run's deferred/changed sets.
 *
 * @module maintenance/docs/scoped-scan
 */

import { scanDocs, scopeFindings, type DocsFinding } from './scan.js';
import type { DocsContext } from './context.js';

/** The findings in this scenario's scope, given the run's deferred/changed sets. */
export async function scopedScan(c: DocsContext): Promise<DocsFinding[]> {
  return scopeFindings(await scanDocs(c.workspaceAt), {
    ...(c.options.roots !== undefined ? { roots: c.options.roots } : {}),
    ...(c.options.exclude !== undefined ? { exclude: c.options.exclude } : {}),
    ...(c.scan.deferred !== undefined ? { deferredFiles: c.scan.deferred } : {}),
    ...(c.scan.changed !== undefined ? { changedPaths: c.scan.changed } : {}),
  });
}
