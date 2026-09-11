/**
 * This repository's maintenance workflows.
 *
 * Project operations rather than product code: each export is a workflow
 * that keeps some part of this repository honest, defined in engine
 * vocabulary (`MaintenanceWorkflow`) with no harness assumed. A front
 * end registers the workflows it wants in its own catalog and adapts
 * them to its contract there.
 *
 * @module maintenance
 */

import { fileURLToPath } from 'node:url';

export { docsMaintenance, repoDocsMaintenance, websiteDocsMaintenance } from './docs-workflow.js';
export type { DocsMaintenanceOptions } from './docs-workflow.js';
export { countReferences, findDocs, findingKey, judgeFix, scanDocs, scopeFindings } from './docs-scan.js';
export type { DocsFinding, DocsVerdict, ScanScope } from './docs-scan.js';
export { coreUpkeep } from './core-workflow.js';
export { scanCore, unfiledFindings } from './core-scan.js';
export type { CoreFinding } from './core-scan.js';
export { issueFix } from './issue-fix.js';
export { optPropose } from './opt-workflow.js';
export { featPropose } from './feat-propose.js';
export { charterOrder, repoAudit } from './audit-workflow.js';
export { auditKey, auditTitle, parseAuditFindings, siftAuditFindings, AUDIT_SEVERITIES } from './audit-findings.js';
export type { AuditFinding, AuditSeverity, AuditSiftOptions, AuditSiftResult } from './audit-findings.js';
export { optApply } from './opt-apply.js';
export { prRevise } from './pr-revise.js';
export { prReview } from './pr-review.js';
export { parseTuneProposal, tuneKey, tunePropose, variantWins, TUNABLE } from './tune.js';
export type { ArmResult, TuneProposal } from './tune.js';
export { featImplement } from './feat-implement.js';
export { extractTicketDiff, parseProposal, pathTokens, proposalKey, safeAcceptanceCommand } from './proposal.js';
export type { FeatureProposal } from './proposal.js';
export { compareBench, parseBenchJson, runAliasedBench } from './bench.js';
export type { BenchComparison, BenchDelta, BenchRow } from './bench.js';
export { commentOnlyChange, eslintDisableCount, findingFromKey, judgeIssueFix, parseIssueFinding, testCount } from './issue-judge.js';
export type { IssueFinding, IssueFixEvidence, IssueFixVerdict } from './issue-judge.js';
export { resolveRepo } from './repo.js';
export type { MaintenanceBuild, MaintenanceEnv, MaintenanceWorkflow } from './types.js';
export { inferProvider, maintenanceEnvFromProcess } from './env.js';

/**
 * Where the docs workflow's source lives, for the improve ladder's
 * editor. Resolved from this module's own location so it stays correct
 * wherever the repository is checked out.
 */
export const docsWorkflowSourcePath = fileURLToPath(new URL('./docs-workflow.ts', import.meta.url));

/** Where the core-upkeep workflow's source lives, likewise. */
export const coreWorkflowSourcePath = fileURLToPath(new URL('./core-workflow.ts', import.meta.url));

/** Where the issue-fix workflow's source lives, likewise. */
export const issueFixSourcePath = fileURLToPath(new URL('./issue-fix.ts', import.meta.url));

/** Where the opt-propose workflow's source lives, likewise. */
export const optWorkflowSourcePath = fileURLToPath(new URL('./opt-workflow.ts', import.meta.url));

/** Where the feat-propose workflow's source lives, likewise. */
export const featProposeSourcePath = fileURLToPath(new URL('./feat-propose.ts', import.meta.url));

/** Where the repo-audit workflow's source lives, likewise. */
export const repoAuditSourcePath = fileURLToPath(new URL('./audit-workflow.ts', import.meta.url));

/** Where the opt-apply workflow's source lives, likewise. */
export const optApplySourcePath = fileURLToPath(new URL('./opt-apply.ts', import.meta.url));

/** Where the pr-revise workflow's source lives, likewise. */
export const prReviseSourcePath = fileURLToPath(new URL('./pr-revise.ts', import.meta.url));

/** Where the pr-review workflow's source lives, likewise. */
export const prReviewSourcePath = fileURLToPath(new URL('./pr-review.ts', import.meta.url));

/** Where the feat-implement workflow's source lives, likewise. */
export const featImplementSourcePath = fileURLToPath(new URL('./feat-implement.ts', import.meta.url));
