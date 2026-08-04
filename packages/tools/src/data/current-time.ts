/**
 * current_time — the current date and time
 *
 * Models don't know today's date; workflows constantly need it. Returns the
 * current instant in ISO, epoch, and human-readable forms, optionally in a
 * requested IANA timezone. Untainted.
 *
 * Nondeterminism is fine here: tool results are recorded in the event log,
 * and replay replays recorded actions rather than re-executing tools.
 *
 * @module data/current-time
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Options for {@link createCurrentTimeTool}. */
export interface CurrentTimeToolOptions {
  /** Default IANA timezone when the model doesn't request one. @default 'UTC' */
  timezone?: string;
}

function formatIn(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(date);
}

/**
 * Create the `current_time` tool.
 */
export function createCurrentTimeTool(options: CurrentTimeToolOptions = {}): DefinedTool {
  const defaultTimezone = options.timezone ?? 'UTC';

  return defineTool({
    name: 'current_time',
    description:
      'Get the current date and time. Optionally pass an IANA timezone ' +
      '(e.g. "America/New_York") to localize the human-readable form.',
    parameters: z.object({
      timezone: z.string().optional().describe('IANA timezone name (default UTC)'),
    }),
    execute: ({ timezone }) => {
      const tz = timezone ?? defaultTimezone;
      const now = new Date();

      let human: string;
      try {
        human = formatIn(tz, now);
      } catch {
        throw new Error(`Unknown timezone "${tz}" — use an IANA name like "Europe/Berlin"`);
      }

      return {
        iso: now.toISOString(),
        unixMs: now.getTime(),
        timezone: tz,
        human,
      };
    },
  });
}
