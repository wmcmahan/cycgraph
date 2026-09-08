/**
 * Git delivery helpers: branch, commit, publish
 *
 * The workspace tools give an agent hands inside a jailed clone; this
 * module is the other half — the procedures the *caller* runs around
 * that clone. Nothing here is a `defineTool` surface, deliberately: a
 * model edits, the harness delivers.
 *
 * @module git
 */

export {
  branchDiff,
  pushBranch,
  changedIn,
  cloneToBranch,
  commit,
  pendingDiff,
  publishBranch,
  publishScript,
} from './branch.js';
export { commentOnPr, openPrFiles, prFeedback } from './pr.js';
export type { PrComment, PrFeedback } from './pr.js';
export { createIssue, findingMarker, issueMarkers, listOpenIssues } from './issues.js';
export type { IssueRef } from './issues.js';
export type { Branch, Published } from './branch.js';
export { DEFAULT_IDENTITY, publishConfigFromEnv } from './config.js';
export type { CommitIdentity, PublishConfig } from './config.js';
export { fillSection, prBodyFor } from './template.js';
export type { PrEvidence } from './template.js';
export { deliveryNodes } from './delivery.js';
export type { DeliveryNode } from './delivery.js';
export type { DeliveryOptions } from './delivery.js';
