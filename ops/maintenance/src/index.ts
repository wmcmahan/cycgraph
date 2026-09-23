/**
 * Repository maintenance workflows.
 * @module maintenance
 */

import { fileURLToPath } from 'node:url';

export { docsMaintenance, repoDocsMaintenance, websiteDocsMaintenance } from './docs/index.js';
export type { DocsMaintenanceOptions } from './docs/index.js';
export { countReferences, findDocs, findingKey, judgeFix, scanDocs, scopeFindings } from './docs/scan.js';
export type { DocsFinding, DocsVerdict, ScanScope } from './docs/scan.js';
export { coreUpkeep } from './code-scan/index.js';
export { scanCore, unfiledFindings } from './code-scan/scan.js';
export type { CoreFinding } from './code-scan/scan.js';
export { issueFix } from './issue-fix/index.js';
export { optPropose } from './optimization-propose/index.js';
export { featPropose } from './feature-propose/index.js';
export { charterOrder, repoAudit } from './repo-audit/index.js';
export { auditKey, auditTitle, legacyAuditKey, parseAuditFindings, siftAuditFindings, AUDIT_SEVERITIES } from './repo-audit/findings.js';
export type { AuditFinding, AuditSeverity, AuditSiftOptions, AuditSiftResult } from './repo-audit/findings.js';
export { optApply } from './optimization-apply/index.js';
export { prRevise } from './pr-revise/index.js';
export { prReview } from './pr-review/index.js';
export { parseTuneProposal, parseTuneTicket, renderTuneTicket, resolveSourcePath, tuneKey, tunePropose, variantWins, TUNABLE } from './tune/index.js';
export type { ArmResult, TuneProposal } from './tune/index.js';
export { featImplement } from './implement-ticket/index.js';
export { extractTicketDiff, legacyProposalKey, parseProposal, pathTokens, proposalKey, runAcceptanceCommands, safeAcceptanceCommand } from './shared/proposal.js';
export { keySlug, legacyKeySlug } from './shared/key-slug.js';
export type { FeatureProposal } from './shared/proposal.js';
export { compareBench, parseBenchJson, runAliasedBench } from './tune/bench.js';
export type { BenchComparison, BenchDelta, BenchRow } from './tune/bench.js';
export { commentOnlyChange, eslintDisableCount, findingFromKey, judgeIssueFix, parseIssueFinding, testCount } from './issue-fix/judge.js';
export type { IssueFinding, IssueFixEvidence, IssueFixVerdict } from './issue-fix/judge.js';
export { resolveRepo } from './shared/repo.js';
export { fetchCiFailureLogs, formatCiFailures, selectFailedRuns } from './shared/ci-logs.js';
export type { CmdRunner, FailedRun, RunRow } from './shared/ci-logs.js';
export { contextOf, defaultMaintenanceContext, maintenanceBranch, resolveStandardsBrief, DEFAULT_STANDARDS_DOCS } from './shared/context.js';
export type { MaintenanceContext, MaintenanceIdentity, MaintenanceLabels } from './shared/context.js';
export type { MaintenanceBuild, MaintenanceEnv, MaintenanceWorkflow } from './types.js';
export { inferProvider, maintenanceEnvFromProcess } from './shared/env.js';

export const docsWorkflowSourcePath = fileURLToPath(new URL('./docs/index.ts', import.meta.url));

export const coreWorkflowSourcePath = fileURLToPath(new URL('./code-scan/index.ts', import.meta.url));

export const issueFixSourcePath = fileURLToPath(new URL('./issue-fix/index.ts', import.meta.url));

export const optWorkflowSourcePath = fileURLToPath(new URL('./optimization-propose/index.ts', import.meta.url));

export const featProposeSourcePath = fileURLToPath(new URL('./feature-propose/index.ts', import.meta.url));

export const repoAuditSourcePath = fileURLToPath(new URL('./repo-audit/index.ts', import.meta.url));

export const optApplySourcePath = fileURLToPath(new URL('./optimization-apply/index.ts', import.meta.url));

export const prReviseSourcePath = fileURLToPath(new URL('./pr-revise/index.ts', import.meta.url));

export const prReviewSourcePath = fileURLToPath(new URL('./pr-review/index.ts', import.meta.url));

export const featImplementSourcePath = fileURLToPath(new URL('./implement-ticket/index.ts', import.meta.url));
