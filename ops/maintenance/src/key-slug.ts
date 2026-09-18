/**
 * The slug every maintenance ledger key is built from.
 *
 * Ledger keys ride in issue markers, so they must stay short and
 * readable; they are also the whole identity a finding has, so two
 * distinct findings must never share one. Those pull against each
 * other, and this module is where the tension is resolved once for
 * every keying function in the workflow set.
 *
 * @module maintenance/key-slug
 */

import { createHash } from 'node:crypto';

/** Characters of normalized text a slug shows before its digest. */
const SLUG_TEXT_LIMIT = 80;

/** Hex characters of the full-text digest a truncated slug carries. */
const SLUG_DIGEST_LENGTH = 8;

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
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (normalized.length <= SLUG_TEXT_LIMIT) return normalized;
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, SLUG_DIGEST_LENGTH);
  return `${normalized.slice(0, SLUG_TEXT_LIMIT).replace(/-$/, '')}-${digest}`;
}
