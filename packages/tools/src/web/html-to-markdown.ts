/**
 * html_to_markdown — compact HTML → markdown/text extraction
 *
 * Raw HTML wastes an LLM's context on markup; a 1 MiB page body might carry
 * a few KiB of actual content. This converter keeps what a model can use —
 * headings, paragraphs, links, lists, code, table cells — and drops
 * scripts, styles, navigation chrome, and embedded frames. Built on
 * htmlparser2's streaming parser; no DOM is constructed.
 *
 * Exposed both as a pure tool (`html_to_markdown`) and as the engine behind
 * `createWebFetchTool`'s `extract` option.
 *
 * @module web/html-to-markdown
 */

import { z } from 'zod';
import { Parser } from 'htmlparser2';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Output mode: markdown keeps structure syntax, text is prose-only. */
export type HtmlExtractMode = 'markdown' | 'text';

/** Tags whose entire subtree is dropped. */
const SKIP_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head',
  'nav', 'footer', 'aside', 'form', 'button', 'select', 'option',
]);

/** Tags that start a new output block. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'blockquote', 'table', 'tr',
  'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'pre',
]);

/** Resolve a link target; returns null for unusable or unsafe schemes. */
function resolveHref(href: string | undefined, baseUrl?: string): string | null {
  if (!href) return null;
  try {
    const resolved = new URL(href, baseUrl);
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null;
  } catch {
    return null;
  }
}

/**
 * Convert an HTML document or fragment to markdown or plain text.
 *
 * @param html - The HTML source.
 * @param options.mode - `'markdown'` (default) or `'text'`.
 * @param options.baseUrl - Base for resolving relative link targets.
 */
export function convertHtml(
  html: string,
  options: { mode?: HtmlExtractMode; baseUrl?: string } = {},
): string {
  const markdown = (options.mode ?? 'markdown') === 'markdown';
  let out = '';
  let skipDepth = 0;
  let preDepth = 0;
  let cellCount = 0;
  const listCounters: Array<number | null> = [];
  const linkHrefs: Array<string | null> = [];

  const block = () => {
    if (out.length > 0 && !out.endsWith('\n\n')) {
      out += out.endsWith('\n') ? '\n' : '\n\n';
    }
  };
  const append = (text: string) => {
    if (preDepth > 0) {
      out += text;
      return;
    }
    const collapsed = text.replace(/\s+/g, ' ');
    if (collapsed === ' ' && (out.endsWith(' ') || out.endsWith('\n') || out.length === 0)) return;
    if ((out.endsWith('\n') || out.length === 0) && collapsed.startsWith(' ')) {
      out += collapsed.trimStart();
      return;
    }
    out += collapsed;
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (SKIP_TAGS.has(name)) {
          skipDepth++;
          return;
        }
        if (skipDepth > 0) return;

        if (BLOCK_TAGS.has(name)) block();

        if (/^h[1-6]$/.test(name) && markdown) {
          out += `${'#'.repeat(Number(name[1]))} `;
        } else if (name === 'ul') {
          listCounters.push(null);
        } else if (name === 'ol') {
          listCounters.push(0);
        } else if (name === 'li') {
          const top = listCounters.length - 1;
          if (top >= 0 && listCounters[top] !== null) {
            listCounters[top] = (listCounters[top] as number) + 1;
            out += `${listCounters[top]}. `;
          } else {
            out += '- ';
          }
        } else if (name === 'pre') {
          if (markdown) out += '```\n';
          preDepth++;
        } else if (name === 'code' && preDepth === 0 && markdown) {
          out += '`';
        } else if (name === 'a' && markdown) {
          const href = resolveHref(attribs.href, options.baseUrl);
          linkHrefs.push(href);
          if (href) out += '[';
        } else if (name === 'br') {
          out += '\n';
        } else if ((name === 'td' || name === 'th') && cellCount++ > 0) {
          out += ' | ';
        } else if (name === 'tr') {
          cellCount = 0;
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        append(text);
      },
      onclosetag(name) {
        if (SKIP_TAGS.has(name)) {
          skipDepth--;
          return;
        }
        if (skipDepth > 0) return;

        if (name === 'pre') {
          preDepth--;
          if (markdown) out += out.endsWith('\n') ? '```' : '\n```';
        } else if (name === 'code' && preDepth === 0 && markdown) {
          out += '`';
        } else if (name === 'a' && markdown) {
          const href = linkHrefs.pop();
          if (href) out += `](${href})`;
        } else if (name === 'ul' || name === 'ol') {
          listCounters.pop();
        }

        if (BLOCK_TAGS.has(name)) block();
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Options for {@link createHtmlToMarkdownTool}. */
export interface HtmlToMarkdownToolOptions {
  /** Per-call timeout forwarded to defineTool. @default 10000 */
  timeoutMs?: number;
  /** Cap on accepted HTML input size in bytes. @default 5 MiB */
  maxInputBytes?: number;
}

/**
 * Create the `html_to_markdown` tool.
 */
export function createHtmlToMarkdownTool(options: HtmlToMarkdownToolOptions = {}): DefinedTool {
  const maxInputBytes = options.maxInputBytes ?? 5 * 1024 * 1024;

  return defineTool({
    name: 'html_to_markdown',
    description:
      'Convert HTML to compact markdown: headings, paragraphs, links, lists, ' +
      'code, and table cells survive; scripts, styles, and navigation chrome are dropped. '
      + 'Pass mode "text" for prose without markdown syntax.',
    parameters: z.object({
      html: z.string().min(1).describe('The HTML source'),
      mode: z.enum(['markdown', 'text']).optional().describe('Output mode (default markdown)'),
      baseUrl: z.url().optional().describe('Base URL for resolving relative links'),
    }),
    timeoutMs: options.timeoutMs ?? 10_000,
    execute: ({ html, mode, baseUrl }) => {
      if (html.length > maxInputBytes) {
        throw new Error(`HTML input (${html.length} bytes) exceeds the ${maxInputBytes}-byte cap`);
      }
      return { content: convertHtml(html, { mode, baseUrl }) };
    },
  });
}
