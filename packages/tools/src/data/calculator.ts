/**
 * calculator — safe arithmetic via a built-in expression parser
 *
 * Evaluates arithmetic and boolean expressions with optional named
 * variables. The evaluator is a small hand-rolled tokenizer + recursive
 * descent parser that only ever yields a number or a boolean — there is no
 * `eval`, no `Function`, and no dependency, so an attacker-authored
 * expression can compute but cannot reach anything. Pure: no taint, no
 * external calls.
 *
 * @module data/calculator
 */

import { z } from 'zod';
import { defineTool, type DefinedTool } from '@cycgraph/orchestrator';

/** Options for {@link createCalculatorTool}. */
export interface CalculatorToolOptions {
  /** Per-call timeout forwarded to defineTool. @default 5000 */
  timeoutMs?: number;
}

// ─── AST ───────────────────────────────────────────────────────────

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; operand: Node }
  | { kind: 'binary'; op: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

interface Token {
  type: 'num' | 'id' | 'op' | 'lparen' | 'rparen' | 'comma';
  value: string;
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/** Built-in functions. `null` arity means variadic (one or more args). */
const FUNCTIONS: Record<string, { arity: number | null; apply: (args: number[]) => number }> = {
  abs: { arity: 1, apply: (a) => Math.abs(a[0]) },
  ceil: { arity: 1, apply: (a) => Math.ceil(a[0]) },
  floor: { arity: 1, apply: (a) => Math.floor(a[0]) },
  round: { arity: 1, apply: (a) => Math.round(a[0]) },
  sqrt: { arity: 1, apply: (a) => Math.sqrt(a[0]) },
  min: { arity: null, apply: (a) => Math.min(...a) },
  max: { arity: null, apply: (a) => Math.max(...a) },
};

// ─── Tokenizer ─────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const isDigit = (c: string) => c >= '0' && c <= '9';
  let i = 0;

  while (i < input.length) {
    const c = input[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(input[i + 1]))) {
      let j = i + 1;
      while (j < input.length && (isDigit(input[j]) || input[j] === '.')) j++;
      if (input[j] === 'e' || input[j] === 'E') {
        j++;
        if (input[j] === '+' || input[j] === '-') j++;
        while (j < input.length && isDigit(input[j])) j++;
      }
      const raw = input.slice(i, j);
      if (!Number.isFinite(Number(raw))) throw new Error(`invalid number "${raw}"`);
      tokens.push({ type: 'num', value: raw });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      tokens.push({ type: 'id', value: input.slice(i, j) });
      i = j;
      continue;
    }

    const two = input.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('+-*/%<>'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }
    if (c === '(') { tokens.push({ type: 'lparen', value: c }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'rparen', value: c }); i++; continue; }
    if (c === ',') { tokens.push({ type: 'comma', value: c }); i++; continue; }

    throw new Error(`unexpected character "${c}"`);
  }
  return tokens;
}

// ─── Parser ────────────────────────────────────────────────────────

function parse(input: string): Node {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  function parseBinaryLevel(next: () => Node, ops: (v: string) => boolean): Node {
    let left = next();
    let t = peek();
    while (t && t.type === 'op' && ops(t.value)) {
      pos++;
      left = { kind: 'binary', op: t.value, left, right: next() };
      t = peek();
    }
    return left;
  }

  const parseExpression = (): Node =>
    parseBinaryLevel(parseAdditive, (v) => COMPARISONS.has(v));
  function parseAdditive(): Node {
    return parseBinaryLevel(parseMultiplicative, (v) => v === '+' || v === '-');
  }
  function parseMultiplicative(): Node {
    return parseBinaryLevel(parseUnary, (v) => v === '*' || v === '/' || v === '%');
  }
  function parseUnary(): Node {
    const t = peek();
    if (t && t.type === 'op' && (t.value === '-' || t.value === '+')) {
      pos++;
      const operand = parseUnary();
      return t.value === '-' ? { kind: 'unary', operand } : operand;
    }
    return parsePrimary();
  }
  function parsePrimary(): Node {
    const t = peek();
    if (!t) throw new Error('unexpected end of expression');

    if (t.type === 'num') {
      pos++;
      return { kind: 'num', value: Number(t.value) };
    }
    if (t.type === 'lparen') {
      pos++;
      const expr = parseExpression();
      if (peek()?.type !== 'rparen') throw new Error('expected ")"');
      pos++;
      return expr;
    }
    if (t.type === 'id') {
      pos++;
      if (peek()?.type === 'lparen') {
        pos++;
        const args: Node[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseExpression());
          while (peek()?.type === 'comma') {
            pos++;
            args.push(parseExpression());
          }
        }
        if (peek()?.type !== 'rparen') throw new Error('expected ")" after function arguments');
        pos++;
        return { kind: 'call', name: t.value, args };
      }
      return { kind: 'var', name: t.value };
    }
    throw new Error(`unexpected token "${t.value}"`);
  }

  const ast = parseExpression();
  if (pos < tokens.length) throw new Error(`unexpected token "${tokens[pos].value}"`);
  return ast;
}

// ─── Evaluator ─────────────────────────────────────────────────────

function evaluate(node: Node, vars: Record<string, number>): number | boolean {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var':
      if (!Object.prototype.hasOwnProperty.call(vars, node.name)) {
        throw new Error(`unknown variable "${node.name}"`);
      }
      return vars[node.name];
    case 'unary':
      return -evalNumber(node.operand, vars);
    case 'binary': {
      const l = evalNumber(node.left, vars);
      const r = evalNumber(node.right, vars);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
        case '==': return l === r;
        case '!=': return l !== r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        default: return l >= r;
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name];
      if (!fn) throw new Error(`unknown function "${node.name}"`);
      if (fn.arity === null && node.args.length === 0) {
        throw new Error(`${node.name}() expects at least one argument`);
      }
      if (fn.arity !== null && node.args.length !== fn.arity) {
        throw new Error(`${node.name}() expects ${fn.arity} argument(s)`);
      }
      return fn.apply(node.args.map((a) => evalNumber(a, vars)));
    }
  }
}

/** Evaluate a node that must yield a number (operands, function args). */
function evalNumber(node: Node, vars: Record<string, number>): number {
  const value = evaluate(node, vars);
  if (typeof value !== 'number') throw new Error('expected a numeric operand');
  return value;
}

/**
 * Create the `calculator` tool.
 */
export function createCalculatorTool(options: CalculatorToolOptions = {}): DefinedTool {
  return defineTool({
    name: 'calculator',
    description:
      'Evaluate an arithmetic or boolean expression, e.g. "(subtotal + shipping) * 1.19" ' +
      'with variables {"subtotal": 100, "shipping": 5}. Supports + - * / %, comparisons, ' +
      'and functions abs, ceil, floor, round, sqrt, min, max.',
    parameters: z.object({
      expression: z.string().min(1).max(500).describe('The expression to evaluate'),
      variables: z
        .record(z.string(), z.number())
        .optional()
        .describe('Named numeric variables referenced by the expression'),
    }),
    timeoutMs: options.timeoutMs ?? 5_000,
    execute: ({ expression, variables }) => {
      let ast: Node;
      try {
        ast = parse(expression);
      } catch (err) {
        throw new Error(`Invalid expression: ${(err as Error).message}`, { cause: err });
      }

      let result: number | boolean;
      try {
        result = evaluate(ast, variables ?? {});
      } catch (err) {
        throw new Error(`Expression evaluation failed: ${(err as Error).message}`, { cause: err });
      }

      if (typeof result === 'number' && !Number.isFinite(result)) {
        throw new Error('Expression evaluated to a non-finite number');
      }
      return { result };
    },
  });
}
