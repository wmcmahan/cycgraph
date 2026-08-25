'use client';

/**
 * The studio's primitive vocabulary over vendored shadcn/ui components,
 * stock styling throughout. What remains custom is semantic, not
 * cosmetic: status tones, the facts table, and the section idiom.
 */

import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { Button as UiButton } from './ui/button';
import { Badge as UiBadge } from './ui/badge';
import { Input as UiInput } from './ui/input';
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { cn } from '../lib/utils';

const BUTTON_VARIANTS = {
  primary: 'default',
  secondary: 'outline',
  ghost: 'ghost',
} as const;

export function Button({
  variant = 'secondary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return <UiButton variant={BUTTON_VARIANTS[variant]} size="sm" className={className} {...props} />;
}

const BADGE_TONES = {
  ok: 'border-ok/40 bg-ok-bg text-ok',
  warn: 'border-warn/40 text-warn',
  bad: 'border-bad/40 bg-bad-bg text-bad',
  dim: 'text-muted-foreground',
  accent: 'border-primary/40 text-primary',
} as const;

export function Badge({
  tone = 'dim',
  className,
  children,
}: { tone?: keyof typeof BADGE_TONES; className?: string; children: ReactNode }) {
  return (
    <UiBadge variant="outline" className={cn(BADGE_TONES[tone], className)}>
      {children}
    </UiBadge>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <UiInput className={className} {...props} />;
}

// Radix refuses an empty item value, and half the studio's selects mean
// "no filter" by one; the sentinel keeps that idiom at the call sites.
const EMPTY = '~empty~';

export interface SelectOption {
  value: string;
  label: string;
}

/** A labelled single-choice control over the vendored Radix select. */
export function Select({
  value,
  onValueChange,
  options,
  placeholder,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  className?: string;
}) {
  return (
    <UiSelect
      value={value === '' ? EMPTY : value}
      onValueChange={(next) => onValueChange(next === EMPTY ? '' : next)}
    >
      <SelectTrigger size="sm" className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value === '' ? EMPTY : option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}

/**
 * The vendored sheet sizes itself through `data-[side=right]:` variants,
 * which tailwind-merge cannot dedupe against unprefixed widths: an override
 * has to match the variant or the stock `sm:max-w-sm` silently wins and the
 * drawer stays 384px wide.
 */
const DRAWER_WIDTH = [
  'data-[side=right]:w-[94vw]',
  'data-[side=right]:sm:w-[46rem]',
  'data-[side=right]:sm:max-w-[94vw]',
  'data-[side=right]:xl:w-[58rem]',
].join(' ');

/** Right-hand drawer for drill-ins; the studio's constant inspection surface. */
export function Drawer({
  open,
  onClose,
  title,
  children,
}: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="right" className={cn('overflow-y-auto', DRAWER_WIDTH)}>
        <SheetHeader>
          <SheetTitle className="text-sm font-medium">{title}</SheetTitle>
          <SheetDescription className="sr-only">Details</SheetDescription>
        </SheetHeader>
        <div className="w-full min-w-0 px-4 pb-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function Section({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Key/value rows for drawers. */
export function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <table className="w-full table-fixed text-xs">
      <tbody>
        {rows.map(([key, value]) => (
          <tr key={key} className="border-b border-border/50 last:border-0">
            <td className="w-28 py-1.5 pr-3 align-top text-muted-foreground">{key}</td>
            <td className="break-words py-1.5 align-top">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-4 text-xs text-muted-foreground">{children}</p>;
}

export function statusTone(status: string): 'ok' | 'bad' | 'dim' | 'warn' {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'crashed') return 'bad';
  if (status === 'waiting' || status === 'running') return 'warn';
  return 'dim';
}

/**
 * The studio's one table idiom: a dense monospace row list. Runs, log
 * lines, and anything else enumerable share it, so two pages listing
 * different things still read as the same instrument.
 *
 * Callers pass a CSS grid template so columns can differ while the
 * spacing, rules, and hover behavior cannot drift apart.
 */
export function RowList({ children }: { children: ReactNode }) {
  return <div className="overflow-hidden font-mono text-[13px]">{children}</div>;
}

export function RowHead({ template, cells }: { template: string; cells: ReactNode[] }) {
  return (
    <div
      className="grid gap-3 border-b px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70"
      style={{ gridTemplateColumns: template }}
    >
      {cells.map((cell, i) => <span key={i} className="truncate">{cell}</span>)}
    </div>
  );
}

/**
 * One row. A row that drills in is a button; a row that merely holds
 * controls is a plain element, because a button cannot contain buttons.
 */
export function Row({
  template,
  cells,
  onClick,
}: { template: string; cells: ReactNode[]; onClick?: () => void }) {
  const className = cn(
    'grid w-full items-center gap-3 border-b border-border/50 px-3 py-1.5 text-left last:border-0',
    onClick && 'hover:bg-muted/30',
  );
  const content = cells.map((cell, i) => <span key={i} className="truncate">{cell}</span>);

  if (!onClick) {
    return <div className={className} style={{ gridTemplateColumns: template }}>{content}</div>;
  }
  return (
    <button type="button" onClick={onClick} className={className} style={{ gridTemplateColumns: template }}>
      {content}
    </button>
  );
}

const STATUS_TEXT = {
  ok: 'text-ok',
  warn: 'text-warn',
  bad: 'text-bad',
  dim: 'text-muted-foreground',
} as const;

/** A status as coloured text, which is how a log line shows its level. */
export function StatusText({ status }: { status: string }) {
  return <span className={STATUS_TEXT[statusTone(status)]}>{status}</span>;
}
