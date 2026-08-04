/**
 * csv_parse — RFC-4180-style CSV parsing
 *
 * Hand-rolled parser (no dependency): quoted fields, doubled-quote escapes,
 * delimiters and newlines inside quotes, CRLF and LF row endings. Header
 * mode returns rows as objects keyed by column name; positional mode
 * returns string arrays. Pure, untainted.
 *
 * Row output is capped per call (`limit`, default 100) with `totalRows`
 * reporting the full count, so a large file never floods the LLM context.
 *
 * @module data/csv-parse
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Options for {@link createCsvParseTool}. */
export interface CsvParseToolOptions {
  /** Cap on accepted CSV input size in bytes. @default 5 MiB */
  maxInputBytes?: number;
  /** Hard cap on rows returned per call. @default 1000 */
  maxRows?: number;
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

/** Parse CSV text into rows of fields. */
export function parseCsv(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAnything = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      sawAnything = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
      sawAnything = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      if (sawAnything || field !== '') {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      sawAnything = false;
    } else {
      field += char;
      sawAnything = true;
    }
  }

  if (sawAnything || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Create the `csv_parse` tool.
 */
export function createCsvParseTool(options: CsvParseToolOptions = {}): DefinedTool {
  const maxInputBytes = options.maxInputBytes ?? 5 * 1024 * 1024;
  const maxRows = options.maxRows ?? 1000;

  return defineTool({
    name: 'csv_parse',
    description:
      'Parse CSV text. With hasHeader (default true), rows come back as objects ' +
      'keyed by column name; otherwise as string arrays. Handles quoted fields, ' +
      'escaped quotes, and delimiters inside quotes.',
    parameters: z.object({
      csv: z.string().min(1).describe('The CSV text'),
      delimiter: z
        .enum([',', ';', '\t', '|'])
        .optional()
        .describe('Field delimiter (default comma)'),
      hasHeader: z.boolean().optional().describe('First row is a header (default true)'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe('Max rows to return (default 100)'),
    }),
    timeoutMs: options.timeoutMs ?? 5_000,
    execute: ({ csv, delimiter, hasHeader, limit }) => {
      if (csv.length > maxInputBytes) {
        throw new Error(`CSV input (${csv.length} bytes) exceeds the ${maxInputBytes}-byte cap`);
      }

      const parsed = parseCsv(csv, delimiter ?? ',');
      const withHeader = hasHeader ?? true;
      const cap = Math.min(limit ?? 100, maxRows);

      if (!withHeader) {
        const dataRows = parsed;
        return {
          headers: null,
          rows: dataRows.slice(0, cap),
          totalRows: dataRows.length,
          truncated: dataRows.length > cap,
        };
      }

      const [headers = [], ...dataRows] = parsed;
      const rows = dataRows.slice(0, cap).map((fields) =>
        Object.fromEntries(headers.map((h, i) => [h, fields[i] ?? ''])),
      );
      return {
        headers,
        rows,
        totalRows: dataRows.length,
        truncated: dataRows.length > cap,
      };
    },
  });
}
