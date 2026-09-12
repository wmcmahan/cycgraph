/**
 * Parsing for the pr-review reviewer's numbered findings, so a review
 * can anchor each one inline on the pull request's diff.
 *
 * Pure logic: the workflow validates parsed anchors against the actual
 * diff before submitting, so nothing here needs a filesystem or `gh`.
 *
 * @module maintenance/review-findings
 */

/** One numbered finding lifted from a review's text. */
export interface ReviewFinding {
  ordinal: number;
  /** Repository-relative path, when the finding opens with one. */
  path?: string;
  /** Line number, when the finding anchors one (`path:line — …`). */
  line?: number;
  /** The finding text with any leading anchor stripped. */
  text: string;
}

const NUMBERED = /^\s*(\d+)\.\s+(.*\S)\s*$/;
const PATH_LINE = /^[`*]*([A-Za-z0-9_@][A-Za-z0-9_./@-]*):(\d+)[`*]*\s*(?:[—:–-]\s*)?(.*)$/;
const PATH_ONLY = /^[`*]*([A-Za-z0-9_@][A-Za-z0-9_./@-]*\.[A-Za-z0-9]+)[`*]*\s*[—–-]\s*(.*)$/;

/**
 * The numbered findings in a review, in order. Each finding is one
 * numbered line (the format the reviewer is instructed to emit); a
 * leading `path:line` or `path` anchor is lifted out, and a finding
 * without one still parses — it simply cannot be placed inline.
 */
export function parseReviewFindings(review: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const line of review.split('\n')) {
    const numbered = line.match(NUMBERED);
    if (!numbered) continue;
    const ordinal = Number(numbered[1]);
    const rest = numbered[2]!;
    const anchored = rest.match(PATH_LINE);
    if (anchored) {
      findings.push({ ordinal, path: anchored[1]!, line: Number(anchored[2]), text: anchored[3]!.trim() || rest });
      continue;
    }
    const pathed = rest.match(PATH_ONLY);
    if (pathed) {
      findings.push({ ordinal, path: pathed[1]!, text: pathed[2]!.trim() || rest });
      continue;
    }
    findings.push({ ordinal, text: rest });
  }
  return findings;
}

/**
 * The bold prefix an inline finding comment opens with. It carries the
 * finding's ordinal only: which review round a thread belongs to comes
 * from the thread's own review association, but the ordinal cannot be
 * inferred — thread order is not finding order, and findings that fail
 * to anchor inline leave gaps in it.
 */
export function inlineFindingMarker(ordinal: number): string {
  return `**Finding ${ordinal}**`;
}

/** The ordinal a thread's first comment was marked with. */
export function parseFindingMarker(body: string): { ordinal: number } | undefined {
  const match = body.match(/^\*\*Finding (\d+)\*\*/);
  return match ? { ordinal: Number(match[1]) } : undefined;
}

/**
 * The prior-review finding ordinals a verification pass marked
 * addressed, from its `FINDING <n>: ADDRESSED — <evidence>` lines.
 */
export function parseAddressedFindings(review: string): number[] {
  const addressed: number[] = [];
  for (const line of review.split('\n')) {
    const match = line.match(/^\s*FINDING\s+(\d+)\s*:\s*ADDRESSED\b/i);
    if (match) addressed.push(Number(match[1]));
  }
  return addressed;
}

/**
 * The reviser's per-feedback-item replies, from its `REPLY <n>: <text>`
 * lines, keyed by the feedback item's number.
 */
export function parseNumberedReplies(report: string): Map<number, string> {
  const replies = new Map<number, string>();
  for (const line of report.split('\n')) {
    const match = line.match(/^\s*REPLY\s+(\d+)\s*:\s*(.*\S)\s*$/i);
    if (match) replies.set(Number(match[1]), match[2]!);
  }
  return replies;
}
