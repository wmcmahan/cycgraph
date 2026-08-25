'use client';

/**
 * A collapsible view over recorded JSON.
 *
 * Engine payloads are wide and deeply nested — a `workflow:complete`
 * carries the entire final state — so a pretty-printed dump buries the few
 * fields a reader came for. Scalars render as key/value rows, empty
 * containers collapse to `{}` / `[]` inline rather than costing a click,
 * and anything with contents is a disclosure that says how much is inside.
 */

import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../lib/utils';

const STRING_CLAMP = 220;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.length}]`;
  if (isObject(value)) {
    const keys = Object.keys(value);
    return `{${keys.length}} ${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}`;
  }
  return '';
}

function Scalar({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);

  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === 'boolean') return <span className="text-warn">{String(value)}</span>;
  if (typeof value === 'number') return <span className="text-primary">{value}</span>;

  const text = String(value);
  if (text.length <= STRING_CLAMP) return <span className="whitespace-pre-wrap break-words">{text}</span>;
  return (
    <span className="whitespace-pre-wrap break-words">
      {expanded ? text : `${text.slice(0, STRING_CLAMP)}…`}{' '}
      <button
        type="button"
        className="text-primary hover:underline"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'less' : `show all ${text.length} chars`}
      </button>
    </span>
  );
}

function Entry({ name, value, depth }: { name: string; value: unknown; depth: number }) {
  const empty = (Array.isArray(value) && value.length === 0)
    || (isObject(value) && Object.keys(value).length === 0);

  if (!isObject(value) && !Array.isArray(value)) {
    return (
      <div className="grid grid-cols-[minmax(88px,180px)_1fr] gap-3 border-b border-border/40 px-2 py-1 last:border-0">
        <span className="truncate text-muted-foreground">{name}</span>
        <Scalar value={value} />
      </div>
    );
  }

  if (empty) {
    return (
      <div className="grid grid-cols-[minmax(88px,180px)_1fr] gap-3 border-b border-border/40 px-2 py-1 last:border-0">
        <span className="truncate text-muted-foreground">{name}</span>
        <span className="text-muted-foreground/60">{Array.isArray(value) ? '[]' : '{}'}</span>
      </div>
    );
  }

  return (
    <details open={depth === 0} className="group border-b border-border/40 last:border-0">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(88px,180px)_1fr] gap-3 px-2 py-1 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-1 truncate">
          <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <span className="truncate">{name}</span>
        </span>
        <span className="truncate text-muted-foreground/70">{summarize(value)}</span>
      </summary>
      <div className="ml-1.5 border-l border-border/40 pl-2">
        <Tree value={value} depth={depth + 1} />
      </div>
    </details>
  );
}

function Tree({ value, depth }: { value: unknown; depth: number }) {
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value as Record<string, unknown>);

  return (
    <>
      {entries.map(([name, item]) => (
        <Entry key={name} name={name} value={item} depth={depth} />
      ))}
    </>
  );
}

/** Render one recorded payload, with an optional key/value filter. */
export function JsonView({ value, filter }: { value: unknown; filter?: string }) {
  if (!isObject(value) && !Array.isArray(value)) {
    return <div className="px-2 py-1 font-mono text-[12px]"><Scalar value={value} /></div>;
  }

  const needle = filter?.trim().toLowerCase();
  const visible = needle
    ? Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([key, item]) =>
        key.toLowerCase().includes(needle) || JSON.stringify(item)?.toLowerCase().includes(needle)),
    )
    : value;

  if (needle && Object.keys(visible).length === 0) {
    return <p className="px-2 py-2 text-xs text-muted-foreground">Nothing under a key or value matching “{filter}”.</p>;
  }

  return (
    <div className={cn('rounded-md bg-muted/30 font-mono text-[12px]')}>
      <Tree value={visible} depth={0} />
    </div>
  );
}
