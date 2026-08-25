/**
 * Flag parsing
 *
 * Reads `--flag value` pairs against a scenario's introspected fields and
 * builds the sparse object those flags describe. Only flags actually passed
 * appear in the result. Defaults and validation stay in Zod, which parses the
 * result, so this file never becomes a second source of truth.
 *
 * @module cli/flags
 */

import type { ParamField } from '../params/introspect.js';
import type { SweepAxis } from '../run/sweep.js';

/** An unrecognised flag, or a value that could not be coerced. */
export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagError';
  }
}

function coerce(raw: string, field: ParamField): unknown {
  switch (field.kind) {
    case 'integer':
    case 'number': {
      const value = Number(raw);
      if (Number.isNaN(value)) throw new FlagError(`${field.flag} expects a number, got "${raw}"`);
      return value;
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw new FlagError(`${field.flag} expects true or false, got "${raw}"`);
    case 'enum':
      if (field.options && !field.options.includes(raw)) {
        throw new FlagError(`${field.flag} expects one of ${field.options.join(', ')}, got "${raw}"`);
      }
      return raw;
    case 'array':
      return raw.split(',').map((part) => part.trim()).filter(Boolean);
    case 'json':
      try {
        return JSON.parse(raw);
      } catch {
        throw new FlagError(`${field.flag} expects JSON, got "${raw}"`);
      }
    default:
      return raw;
  }
}

/** Write `value` at a dotted path, creating intermediate objects. */
function assign(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (!last) return;

  let cursor = target;
  for (const segment of segments) {
    if (typeof cursor[segment] !== 'object' || cursor[segment] === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
}

/**
 * Pull `--vary <path>=<v1>,<v2>` axes out of an argv slice.
 *
 * Deliberately not `--score 0.3,0.6`: array parameters already use commas, so
 * overloading a normal flag would make `--manages a,b` ambiguous between one
 * list and two variants. `--vary` says which reading is meant.
 *
 * @returns The axes, and argv with them removed.
 */
export function takeSweepAxes(
  argv: string[],
  fields: readonly ParamField[],
): { axes: SweepAxis[]; rest: string[] } {
  const byPath = new Map(fields.map((field) => [field.path, field]));
  const axes: SweepAxis[] = [];
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token !== '--vary') {
      if (token !== undefined) rest.push(token);
      continue;
    }

    const spec = argv[++index];
    if (spec === undefined) throw new FlagError('--vary expects <param>=<value,value>');

    const eq = spec.indexOf('=');
    if (eq < 0) throw new FlagError(`--vary expects <param>=<value,value>, got "${spec}"`);

    const path = spec.slice(0, eq);
    const field = byPath.get(path);
    if (!field) {
      throw new FlagError(`--vary names unknown parameter "${path}". Try \`params <scenario>\`.`);
    }

    const values = spec.slice(eq + 1).split(',').map((raw) => coerce(raw.trim(), field));
    if (values.length === 0) throw new FlagError(`--vary ${path} lists no values`);
    axes.push({ path, values });
  }

  return { axes, rest };
}

/**
 * Parse scenario flags out of an argv slice.
 *
 * Boolean fields accept a bare `--verbose` as well as `--verbose false`, since
 * requiring a value for a flag that reads as a switch surprises everyone.
 *
 * @returns The sparse parameter object, ready for the schema to parse.
 */
export function parseFlags(argv: string[], fields: readonly ParamField[]): Record<string, unknown> {
  const byFlag = new Map(fields.map((field) => [field.flag, field]));
  const result: Record<string, unknown> = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;

    const [flag, inlineValue] = token.includes('=')
      ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)]
      : [token, undefined];

    const field = byFlag.get(flag);
    if (!field) throw new FlagError(`Unknown flag ${flag}`);

    if (inlineValue !== undefined) {
      assign(result, field.path, coerce(inlineValue, field));
      continue;
    }

    const next = argv[index + 1];
    if (field.kind === 'boolean' && (next === undefined || next.startsWith('--'))) {
      assign(result, field.path, true);
      continue;
    }
    if (next === undefined) throw new FlagError(`${flag} expects a value`);

    assign(result, field.path, coerce(next, field));
    index++;
  }

  return result;
}
