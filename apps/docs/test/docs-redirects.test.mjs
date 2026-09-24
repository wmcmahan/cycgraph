import { describe, it, expect } from 'vitest';
import { buildDocsRedirects } from '../src/docs-redirects.mjs';

describe('buildDocsRedirects', () => {
  it('maps a docs page to its canonical Starlight URL', () => {
    const files = ['concepts/graphs.md'];

    const redirects = buildDocsRedirects(files);

    expect(redirects['/concepts/graphs']).toBe('/docs/concepts/graphs/');
  });

  it('skips the docs root index', () => {
    const files = ['index.mdx'];

    const redirects = buildDocsRedirects(files);

    expect(redirects).toEqual({ '/docs': '/docs/getting-started/introduction/' });
  });

  it('maps a nested directory index to its parent directory slug', () => {
    const files = ['guides/index.mdx'];

    const redirects = buildDocsRedirects(files);

    expect(redirects['/guides']).toBe('/docs/guides/');
  });

  it('ignores files that are not Markdown', () => {
    const files = ['concepts/diagram.png', 'concepts/notes.txt', 'concepts/graphs.md'];

    const redirects = buildDocsRedirects(files);

    expect(redirects).toEqual({
      '/concepts/graphs': '/docs/concepts/graphs/',
      '/docs': '/docs/getting-started/introduction/',
    });
  });

  it('throws when a page and a directory index claim the same slug', () => {
    const files = ['guides/index.mdx', 'guides.mdx'];

    expect(() => buildDocsRedirects(files)).toThrow(
      'Duplicate docs redirect slug "guides": "guides.mdx" and "guides/index.mdx" both resolve to /docs/guides/',
    );
  });

  it('normalizes Windows path separators', () => {
    const files = ['patterns\\swarm.md'];

    const redirects = buildDocsRedirects(files);

    expect(redirects['/patterns/swarm']).toBe('/docs/patterns/swarm/');
  });

  it('always emits the docs home redirect', () => {
    const redirects = buildDocsRedirects([]);

    expect(redirects['/docs']).toBe('/docs/getting-started/introduction/');
  });
});
