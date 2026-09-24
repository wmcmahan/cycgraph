import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Canonical landing page served for the bare `/docs` path. */
const DOCS_HOME = '/docs/getting-started/introduction/';

/**
 * List every file under `root`, recursively.
 *
 * @param {string} root Absolute path of the docs content root.
 * @returns {string[]} Paths relative to `root`, always POSIX-separated.
 */
export function listDocsFiles(root) {
  /** @type {string[]} */
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(root);
  return files;
}

/**
 * The slug a docs content file is served under, or `null` when the file is not
 * a page: anything that is not Markdown, and the docs root index, which
 * Starlight already serves at `/docs/`.
 *
 * @param {string} file Path relative to the docs content root.
 * @returns {string | null}
 */
function slugFor(file) {
  const path = file.replace(/\\/g, '/');
  if (!/\.mdx?$/.test(path)) return null;
  const slug = path.replace(/\.mdx?$/, '').replace(/\/index$/, '');
  if (slug === 'index' || slug === '') return null;
  return slug;
}

/**
 * Build the redirect map from legacy top-level docs paths (`/<slug>`) to their
 * canonical Starlight URLs (`/docs/<slug>/`), plus the `/docs` home redirect.
 *
 * Two files that resolve to the same slug — `foo.mdx` and `foo/index.mdx` —
 * throw rather than silently dropping one redirect. Input is sorted first, so
 * the error names the same pair regardless of directory walk order.
 *
 * @param {string[]} files Docs content paths relative to the content root.
 * @returns {Record<string, string>} Redirect source path to destination URL.
 * @throws {Error} When two content files claim the same slug.
 */
export function buildDocsRedirects(files) {
  /** @type {Record<string, string>} */
  const redirects = {};
  /** @type {Record<string, string>} */
  const sources = {};

  for (const file of [...files].sort()) {
    const slug = slugFor(file);
    if (slug === null) continue;
    const claimed = sources[slug];
    if (claimed !== undefined) {
      throw new Error(
        `Duplicate docs redirect slug "${slug}": "${claimed}" and "${file}" both resolve to /docs/${slug}/`,
      );
    }
    sources[slug] = file;
    redirects[`/${slug}`] = `/docs/${slug}/`;
  }

  redirects['/docs'] = DOCS_HOME;

  return redirects;
}
