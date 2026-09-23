/**
 * The slug every maintenance ledger key is built from.
 *
 * Ledger keys ride in issue markers, so they must stay short and
 * readable; they are also the whole identity a finding has, so two
 * distinct findings must never share one. Those pull against each
 * other, and this module is where the tension is resolved once for
 * every text-derived keying function in the workflow set — the audit,
 * code-scan, feature-proposal, and optimization keys all slug their
 * text here; `tuneKey` keys off a digest of its own.
 *
 * Keys written before slugs carried a digest are still on the ledger,
 * so dedupe reads {@link legacyKeySlug} alongside {@link keySlug}.
 *
 * @module maintenance/key-slug
 */

import { createHash } from 'node:crypto';

/** Characters of normalized text a slug shows before its digest. */
const SLUG_TEXT_LIMIT = 80;

/** Hex characters of the full-text digest a truncated slug carries. */
const SLUG_DIGEST_LENGTH = 8;

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Normalize text into a ledger-key slug: lowercased, every run of
 * non-alphanumerics collapsed to one dash, no leading or trailing dash,
 * and at most {@link SLUG_TEXT_LIMIT} characters of that text.
 *
 * Two texts share a slug only when their whole normalized forms are
 * equal. Text past the limit is not simply dropped: the slug keeps a
 * readable prefix and appends a digest of the entire normalized string,
 * so texts that agree for their first 80 characters and diverge after
 * still key apart. A collision there would be silent and costly — the
 * sift and the unfiled filter read equal keys as duplicates, so one
 * real finding would be dropped as a copy of an unrelated one.
 */
export function keySlug(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= SLUG_TEXT_LIMIT) return normalized;
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, SLUG_DIGEST_LENGTH);
  return `${normalized.slice(0, SLUG_TEXT_LIMIT).replace(/-$/, '')}-${digest}`;
}

/**
 * The slug form ledger keys carried before they carried a digest:
 * normalized text bare-truncated at {@link SLUG_TEXT_LIMIT}.
 *
 * Keys already live in issue markers on GitHub, and dedupe is exact
 * string equality, so a finding filed under this form stays invisible
 * to a check that only knows {@link keySlug} and gets re-filed. Write
 * new keys with {@link keySlug}; read the ledger with both.
 */
export function legacyKeySlug(text: string): string {
  return normalizeText(text).slice(0, SLUG_TEXT_LIMIT);
}
