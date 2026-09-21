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

export { docsMaintenance, repoDocsMaintenance, websiteDocsMaintenance } from './docs/index.js';
export type { DocsMaintenanceOptions } from './docs/index.js';
export { countReferences, findDocs, findingKey, judgeFix, scanDocs, scopeFindings } from './docs/scan.js';
export type { DocsFinding, DocsVerdict, ScanScope } from './docs/scan.js';
export { coreUpkeep } from './core/index.js';
export { scanCore, unfiledFindings } from './core/scan.js';
export type { CoreFinding } from './core/scan.js';
export { issueFix } from './issue-fix/index.js';
export { optPropose } from './opt/propose.js';
export { featPropose } from './feat/propose.js';
export { charterOrder, repoAudit } from './audit/index.js';
export { auditKey, auditTitle, legacyAuditKey, parseAuditFindings, siftAuditFindings, AUDIT_SEVERITIES } from './audit/findings.js';
export type { AuditFinding, AuditSeverity, AuditSiftOptions, AuditSiftResult } from './audit/findings.js';
export { optApply } from './opt/apply.js';
export { prRevise } from './pr-revise/index.js';
export { prReview } from './pr-review/index.js';
export { parseTuneProposal, parseTuneTicket, renderTuneTicket, resolveSourcePath, tuneKey, tunePropose, variantWins, TUNABLE } from './tune/index.js';
export type { ArmResult, TuneProposal } from './tune/index.js';
export { featImplement } from './feat/implement.js';
export { extractTicketDiff, legacyProposalKey, parseProposal, pathTokens, proposalKey, safeAcceptanceCommand } from './shared/proposal.js';
export { keySlug, legacyKeySlug } from './shared/key-slug.js';
export type { FeatureProposal } from './shared/proposal.js';
export { compareBench, parseBenchJson, runAliasedBench } from './tune/bench.js';
export type { BenchComparison, BenchDelta, BenchRow } from './tune/bench.js';
export { commentOnlyChange, eslintDisableCount, findingFromKey, judgeIssueFix, parseIssueFinding, testCount } from './issue-fix/judge.js';
export type { IssueFinding, IssueFixEvidence, IssueFixVerdict } from './issue-fix/judge.js';
export { resolveRepo } from './shared/repo.js';
export type { MaintenanceBuild, MaintenanceEnv, MaintenanceWorkflow } from './types.js';
export { inferProvider, maintenanceEnvFromProcess } from './shared/env.js';

/**
 * Where the docs workflow's source lives, for the improve ladder's
 * editor. Resolved from this module's own location so it stays correct
 * wherever the repository is checked out.
 */
export const docsWorkflowSourcePath = fileURLToPath(new URL('./docs/index.ts', import.meta.url));

/** Where the core-upkeep workflow's source lives, likewise. */
export const coreWorkflowSourcePath = fileURLToPath(new URL('./core/index.ts', import.meta.url));

/** Where the issue-fix workflow's source lives, likewise. */
export const issueFixSourcePath = fileURLToPath(new URL('./issue-fix/index.ts', import.meta.url));

/** Where the opt-propose workflow's source lives, likewise. */
export const optWorkflowSourcePath = fileURLToPath(new URL('./opt/propose.ts', import.meta.url));

/** Where the feat-propose workflow's source lives, likewise. */
export const featProposeSourcePath = fileURLToPath(new URL('./feat/propose.ts', import.meta.url));

/** Where the repo-audit workflow's source lives, likewise. */
export const repoAuditSourcePath = fileURLToPath(new URL('./audit/index.ts', import.meta.url));

/** Where the opt-apply workflow's source lives, likewise. */
export const optApplySourcePath = fileURLToPath(new URL('./opt/apply.ts', import.meta.url));

/** Where the pr-revise workflow's source lives, likewise. */
export const prReviseSourcePath = fileURLToPath(new URL('./pr-revise/index.ts', import.meta.url));

/** Where the pr-review workflow's source lives, likewise. */
export const prReviewSourcePath = fileURLToPath(new URL('./pr-review/index.ts', import.meta.url));

/** Where the feat-implement workflow's source lives, likewise. */
export const featImplementSourcePath = fileURLToPath(new URL('./feat/implement.ts', import.meta.url));
