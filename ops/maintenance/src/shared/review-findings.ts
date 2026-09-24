/**
 * The text conventions pr-review and pr-revise exchange on a pull
 * request: the reviewer's numbered findings, the hidden markers that
 * identify what each workflow posted, the per-thread verdict lines of a
 * verification pass, and the reviser's per-item replies.
 *
 * Pure logic: the workflows validate anchors against the actual diff and
 * talk to GitHub, so nothing here needs a filesystem or `gh`.
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
  /** The indented continuation lines beneath the finding, trimmed. */
  evidence: string[];
}

const NUMBERED = /^(\s*)(\d+)\.\s+(.*\S)\s*$/;
const PATH_LINE = /^[`*]*([A-Za-z0-9_@][A-Za-z0-9_./@-]*):(\d+)[`*]*\s*(?:[—:–-]\s*)?(.*)$/;
const PATH_ONLY = /^[`*]*([A-Za-z0-9_@][A-Za-z0-9_./@-]*\.[A-Za-z0-9]+)[`*]*\s*[—–-]\s*(.*)$/;
const INDENTED = /^\s+\S/;
const THREAD_VERDICT = /^[\s*_`-]*(?:THREAD\s+)?T(\d+)[*_`]*\s*:\s*[*_`]*(ADDRESSED|UNRESOLVED)\b[*_`]*\s*(?:[—–:-]\s*)?(.*)$/i;
const PRIOR_VERDICT = /^[\s*_`-]*P(\d+)[*_`]*\s*:\s*[*_`]*(ADDRESSED|UNRESOLVED)\b[*_`]*\s*(?:[—–:-]\s*)?(.*)$/i;
const REPLY = /^[\s*_`]*REPLY\s+([TC]\d+)[*_`]*\s*:\s*(.*\S)\s*$/i;

/** The heading of the review body's section of findings about the change as a whole. */
export const OVERALL_HEADING = '**Overall**';

/** The heading of the review body's list of earlier overall points now addressed. */
export const RESOLVED_HEADING = '**Resolved since the last review**';

/** The prefix an earlier overall point carries while it stays open. */
const STILL_OPEN = 'Still open from the last review: ';

/** A finding and the line span it occupies in the review text, end exclusive. */
type FindingSpan = { finding: ReviewFinding; start: number; end: number };

/** Lift the anchor off a numbered finding's first line. */
function anchorOf(rest: string): Pick<ReviewFinding, 'path' | 'line' | 'text'> {
  const anchored = rest.match(PATH_LINE);
  if (anchored) return { path: anchored[1]!, line: Number(anchored[2]), text: anchored[3]!.trim() || rest };
  const pathed = rest.match(PATH_ONLY);
  if (pathed) return { path: pathed[1]!, text: pathed[2]!.trim() || rest };
  return { text: rest };
}

/**
 * Every finding with its span. A finding owns the indented lines after
 * it, blank lines between them included; the next numbered line or any
 * unindented text ends it.
 */
function findingSpans(lines: readonly string[]): FindingSpan[] {
  const spans: FindingSpan[] = [];
  let i = 0;
  while (i < lines.length) {
    const numbered = lines[i]!.match(NUMBERED);
    if (!numbered) {
      i += 1;
      continue;
    }
    const start = i;
    let end = i + 1;
    const evidence: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (line.trim() === '') continue;
      if (NUMBERED.test(line) || !INDENTED.test(line)) break;
      evidence.push(line.trim());
      end = j + 1;
    }
    spans.push({ finding: { ordinal: Number(numbered[2]), ...anchorOf(numbered[3]!), evidence }, start, end });
    i = end;
  }
  return spans;
}

/**
 * The numbered findings in a review, in order. A leading `path:line` or
 * `path` anchor is lifted out, and a finding without one still parses:
 * it simply cannot be placed inline.
 */
export function parseReviewFindings(review: string): ReviewFinding[] {
  return findingSpans(review.split('\n')).map((span) => span.finding);
}

/** What a workflow-posted comment on a pull request is. */
export type ReviewMarkerKind = 'review' | 'finding' | 'verify' | 'reply' | 'revision' | 'notice';

/**
 * Where a posted comment came from: the recorded run that wrote it, the
 * commit it was written against, and the model that wrote it. Carried in
 * the hidden marker so later tooling can attribute each finding.
 */
export interface Provenance {
  /** The recorded run id, the handle a replay or fork takes. */
  run?: string;
  commit?: string;
  model?: string;
}

/** Characters a provenance value may hold: enough for ids, shas, and model names, never a marker terminator. */
const PROVENANCE_VALUE = /^[A-Za-z0-9._:/@-]+$/;
const MARKER = /<!-- cycgraph:pr-(review|finding|verify|reply|revision|notice)((?: [a-z]+=[^\s>]+)*) -->/;

/**
 * The hidden marker a workflow stamps on what it posts. It renders as
 * nothing on GitHub and identifies the comment's role, and optionally its
 * provenance, to later runs. A provenance value that could break out of
 * the comment is left out. The namespace is distinct from the issue
 * pipeline's `cycgraph:finding=` markers, which other jobs search for.
 */
export function reviewMarker(kind: ReviewMarkerKind, provenance: Provenance = {}): string {
  const fields = (['run', 'commit', 'model'] as const).flatMap((key) => {
    const value = provenance[key];
    return value !== undefined && PROVENANCE_VALUE.test(value) ? [` ${key}=${value}`] : [];
  });
  return `<!-- cycgraph:pr-${kind}${fields.join('')} -->`;
}

/** The marker kind a comment carries, if any. */
export function markerKindOf(body: string): ReviewMarkerKind | undefined {
  const match = body.match(MARKER);
  return match ? (match[1] as ReviewMarkerKind) : undefined;
}

/** The provenance a comment's marker carries, if it has a marker. */
export function markerProvenance(body: string): Provenance | undefined {
  const match = body.match(MARKER);
  if (!match) return undefined;
  const provenance: Provenance = {};
  for (const field of match[2]!.trim().split(' ').filter((part) => part !== '')) {
    const [key, value] = field.split('=', 2) as [string, string];
    if (key === 'run' || key === 'commit' || key === 'model') provenance[key] = value;
  }
  return provenance;
}

/** A body with any workflow marker removed, for showing it to an agent. */
export function withoutMarkers(body: string): string {
  return body.replace(/<!-- cycgraph:pr-[a-z]+(?: [a-z]+=[^\s>]+)* -->\n?/g, '').trim();
}

/**
 * Whether a thread's opening comment is a pr-review finding. Threads
 * opened before the hidden marker existed carry a visible bold
 * `**Finding N**` prefix instead, and still count.
 */
export function isFindingThread(openingBody: string): boolean {
  return markerKindOf(openingBody) === 'finding' || /^\*\*Finding \d+\*\*/.test(openingBody);
}

/**
 * The body of the comment a finding posts as: the marker, the finding's
 * own line, and its evidence folded into a collapsed block so the thread
 * reads short while the full text stays in the comment. A comment on a
 * whole file names the finding's line in its text, since nothing else
 * shows it.
 */
export function inlineFindingBody(finding: ReviewFinding, options: { onFile?: boolean; provenance?: Provenance } = {}): string {
  const text = options.onFile === true && finding.line !== undefined ? `Line ${finding.line}: ${finding.text}` : finding.text;
  const evidence = finding.evidence.length > 0
    ? `\n\n<details><summary>Evidence</summary>\n\n${finding.evidence.join('\n')}\n\n</details>`
    : '';
  return `${reviewMarker('finding', options.provenance)}\n${text}${evidence}`;
}

/** An earlier overall point a verification pass judges, by its `P<n>` label. */
export interface PriorFinding {
  label: string;
  text: string;
}

/** A bullet with its evidence as nested bullets, which Markdown keeps on their own lines. */
function bullet(text: string, evidence: readonly string[]): string {
  return [`- ${text}`, ...evidence.map((line) => `  - ${line}`)].join('\n');
}

/** A finding's text, led by its location when it has one. */
function located(finding: ReviewFinding): string {
  if (finding.path === undefined) return finding.text;
  return `\`${finding.path}${finding.line !== undefined ? `:${finding.line}` : ''}\` ${finding.text}`;
}

/**
 * The review text for the review body, once the findings in `placed` are
 * posted as comments on the diff. The reviewer's prose stays as written;
 * its numbered findings and its thread and prior verdict lines are taken
 * out. What remains to say about the change as a whole is listed without
 * numbers under {@link OVERALL_HEADING}: the findings that were not
 * placed, then the earlier overall points still open. Earlier points
 * judged addressed are listed under {@link RESOLVED_HEADING}.
 */
export function composeReviewBody(review: string, placed: ReadonlySet<number>, prior: readonly PriorFinding[] = []): string {
  const lines = review.split('\n');
  const spans = findingSpans(lines);
  const inFinding = new Set(spans.flatMap((span) => Array.from({ length: span.end - span.start }, (_, k) => span.start + k)));
  const prose = lines
    .filter((line, i) => !inFinding.has(i) && !THREAD_VERDICT.test(line) && !PRIOR_VERDICT.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const verdicts = new Map(parsePriorVerdicts(review).map((verdict) => [verdict.label, verdict]));
  const noteOf = (label: string): string[] => {
    const text = verdicts.get(label)?.note ?? '';
    return text !== '' ? [text] : [];
  };
  const overall = [
    ...spans.filter((span) => !placed.has(span.finding.ordinal)).map((span) => bullet(located(span.finding), span.finding.evidence)),
    ...prior.filter((point) => verdicts.get(point.label)?.addressed !== true)
      .map((point) => bullet(`${STILL_OPEN}${point.text}`, noteOf(point.label))),
  ];
  const resolved = prior.filter((point) => verdicts.get(point.label)?.addressed === true)
    .map((point) => bullet(point.text, noteOf(point.label)));

  return [
    prose,
    ...(overall.length > 0 ? [[OVERALL_HEADING, ...overall].join('\n')] : []),
    ...(resolved.length > 0 ? [[RESOLVED_HEADING, ...resolved].join('\n')] : []),
  ].filter((part) => part !== '').join('\n\n');
}

/**
 * The findings listed under {@link OVERALL_HEADING} in a posted review
 * body, numbered by their order there. A point carried forward from an
 * earlier review is read without its still-open prefix, so it does not
 * gain another one each round.
 */
export function parseOverallFindings(body: string): ReviewFinding[] {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === OVERALL_HEADING);
  if (start === -1) return [];
  const findings: ReviewFinding[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('- ')) {
      const text = line.slice(2).trim();
      findings.push({ ordinal: findings.length + 1, text: text.startsWith(STILL_OPEN) ? text.slice(STILL_OPEN.length) : text, evidence: [] });
    } else if (INDENTED.test(line) && findings.length > 0) {
      findings[findings.length - 1]!.evidence.push(line.trim().replace(/^-\s+/, ''));
    } else {
      break;
    }
  }
  return findings;
}

/** One verification-pass judgment of an open finding thread or earlier overall point. */
export interface ThreadVerdict {
  /** The item's label in the reviewer's instruction, e.g. `T2` or `P1`. */
  label: string;
  addressed: boolean;
  /** The reviewer's evidence for the judgment. */
  note: string;
}

/**
 * The thread verdicts a verification pass wrote, from its
 * `T<n>: ADDRESSED — …` and `T<n>: UNRESOLVED — …` lines. A blockquoted
 * line never counts, so quoting an earlier review cannot resolve a thread.
 */
export function parseThreadVerdicts(review: string): ThreadVerdict[] {
  return review.split('\n').flatMap((line) => {
    const match = line.match(THREAD_VERDICT);
    return match
      ? [{ label: `T${match[1]}`, addressed: match[2]!.toUpperCase() === 'ADDRESSED', note: match[3]!.trim() }]
      : [];
  });
}

/**
 * The judgments a verification pass wrote on earlier overall points, from
 * its `P<n>: ADDRESSED — …` and `P<n>: UNRESOLVED — …` lines.
 */
export function parsePriorVerdicts(review: string): ThreadVerdict[] {
  return review.split('\n').flatMap((line) => {
    const match = line.match(PRIOR_VERDICT);
    return match
      ? [{ label: `P${match[1]}`, addressed: match[2]!.toUpperCase() === 'ADDRESSED', note: match[3]!.trim() }]
      : [];
  });
}

/**
 * The reviser's replies, from its `REPLY <label>: <text>` lines, keyed by
 * the feedback item's label: `T<n>` for a review thread, `C<n>` for a
 * top-level comment.
 */
export function parseReplies(report: string): Map<string, string> {
  const replies = new Map<string, string>();
  for (const line of report.split('\n')) {
    const match = line.match(REPLY);
    if (match) replies.set(match[1]!.toUpperCase(), match[2]!);
  }
  return replies;
}

/** A reviser report with its REPLY lines removed, for the summary comment. */
export function withoutReplies(report: string): string {
  return report.split('\n').filter((line) => !REPLY.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The review's verdict, read tolerantly: the marker may arrive bolded,
 * as a heading, lowercased, or with the colon dropped. A blockquoted
 * line never counts, so a verification pass quoting the prior review
 * cannot inherit its verdict.
 */
export function parseReviewVerdict(review: string): 'APPROVE' | 'REVISE' | undefined {
  const match = review.match(/^[ \t*_#`]*VERDICT\b\s*:?\s*[*_`]*(APPROVE|REVISE)\b/im);
  return match ? (match[1]!.toUpperCase() as 'APPROVE' | 'REVISE') : undefined;
}
