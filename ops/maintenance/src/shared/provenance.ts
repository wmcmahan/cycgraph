/**
 * Provenance for what the review workflows post: the Actions run a
 * comment came from, the one-line footer that names the commit, model,
 * and run on a review body or revision summary, and the dry-run preview
 * that shows what a run would post without posting it.
 *
 * @module maintenance/provenance
 */

/** The run a maintenance workflow is executing as. */
export interface RunProvenance {
  /** The recorded run id, fixed before the graph runs so what it posts can name it. */
  runId: string;
  /** The GitHub Actions run page, when the workflow runs in Actions. */
  runUrl?: string;
}

/** The first characters of every provenance footer, which agents' views strip. */
export const FOOTER_OPEN = '<sub>';

/**
 * The Actions run page for the current job, from the variables GitHub
 * sets on every Actions runner. Absent outside Actions.
 */
export function actionsRunUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  const server = env['GITHUB_SERVER_URL'];
  const repository = env['GITHUB_REPOSITORY'];
  const runId = env['GITHUB_RUN_ID'];
  if (!server || !repository || !runId) return undefined;
  const attempt = env['GITHUB_RUN_ATTEMPT'];
  return `${server}/${repository}/actions/runs/${runId}${attempt && attempt !== '1' ? `/attempts/${attempt}` : ''}`;
}

/**
 * The visible provenance line: what the work was done against, which
 * model did it, and a link to the run when there is one. Small text, so
 * it reads as metadata rather than review content.
 */
export function provenanceFooter(
  verb: 'Reviewed at' | 'Revised in',
  facts: { commit?: string; model?: string; runUrl?: string },
): string {
  const parts = [
    ...(facts.commit ? [`${verb} \`${facts.commit.slice(0, 7)}\``] : []),
    ...(facts.model ? [`with ${facts.model}`] : []),
    ...(facts.runUrl ? [`[workflow run](${facts.runUrl})`] : []),
  ];
  return parts.length > 0 ? `${FOOTER_OPEN}${parts.join(' · ')}</sub>` : '';
}

/** One thing a dry run would have posted or done, and its exact text. */
export interface PreviewSection {
  title: string;
  body: string;
}

/**
 * A dry run's report of what it would post, in posting order, each item
 * under a rule naming where it would go. Bodies are shown verbatim,
 * markers included, so the preview is exactly what GitHub would receive.
 */
export function dryRunPreview(sections: readonly PreviewSection[]): string {
  if (sections.length === 0) return 'nothing would be posted';
  return sections.map((section) => `── ${section.title}\n${section.body}`).join('\n\n');
}
