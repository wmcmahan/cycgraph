/**
 * The repo-audit agents: the auditor (fanned out under one charter) and the
 * lesson distiller the reflection tail uses.
 *
 * @module maintenance/repo-audit/agents
 */

import { auditorAgent } from './auditor.js';
import { distillerAgent } from './distiller.js';

export { auditorAgent, distillerAgent };

/** The two agents one repo-audit run builds. */
export type RepoAuditAgents = {
  auditor: ReturnType<typeof auditorAgent>;
  distiller: ReturnType<typeof distillerAgent>;
};
