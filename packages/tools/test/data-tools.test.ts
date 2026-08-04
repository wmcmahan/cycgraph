/**
 * Tests for the data tool factories (src/data/calculator.ts,
 * src/data/json-transform.ts). Both are pure: no network, no taint.
 */

import { describe, it, expect } from 'vitest';
import { createCalculatorTool } from '../src/data/calculator.js';
import { createJsonTransformTool } from '../src/data/json-transform.js';

type CalcResult = { result: number | boolean };
type TransformResult = { result: unknown };

describe('createCalculatorTool', () => {
  const tool = createCalculatorTool();

  it('declares the calculator name without taint', () => {
    expect(tool.name).toBe('calculator');
    expect(tool.taints).toBe(false);
  });

  it('evaluates arithmetic with variables', async () => {
    const { result } = (await tool.execute({
      expression: '(subtotal + shipping) * 2',
      variables: { subtotal: 100, shipping: 5 },
    })) as CalcResult;

    expect(result).toBe(210);
  });

  it('evaluates built-in functions', async () => {
    const { result } = (await tool.execute({
      expression: 'max(a, b) + sqrt(c)',
      variables: { a: 3, b: 7, c: 16 },
    })) as CalcResult;

    expect(result).toBe(11);
  });

  it('evaluates boolean comparisons', async () => {
    const { result } = (await tool.execute({
      expression: 'total > 100',
      variables: { total: 150 },
    })) as CalcResult;

    expect(result).toBe(true);
  });

  it('rejects an unparseable expression', async () => {
    await expect(tool.execute({ expression: '1 +* 2' })).rejects.toThrow(/Invalid expression/);
  });

  it('rejects an expression referencing a missing variable', async () => {
    await expect(tool.execute({ expression: 'a + b', variables: { a: 1 } })).rejects.toThrow(
      /Expression evaluation failed/,
    );
  });

  it('rejects division producing a non-finite result', async () => {
    await expect(tool.execute({ expression: '1 / 0' })).rejects.toThrow(/non-finite/);
  });

  it('evaluates subtraction, division, and modulo', async () => {
    const { result } = (await tool.execute({ expression: '17 - 6 / 2 % 4' })) as CalcResult;

    expect(result).toBe(14);
  });

  it('applies unary minus and nested parentheses', async () => {
    const { result } = (await tool.execute({
      expression: '-(a - (b + 1))',
      variables: { a: 2, b: 3 },
    })) as CalcResult;

    expect(result).toBe(2);
  });

  it.each([
    ['3 == 3', true],
    ['3 != 4', true],
    ['2 <= 2', true],
    ['5 >= 6', false],
    ['1 < 2', true],
  ])('evaluates comparison %s', async (expression, expected) => {
    const { result } = (await tool.execute({ expression })) as CalcResult;

    expect(result).toBe(expected);
  });

  it('supports variadic min and max', async () => {
    const { result } = (await tool.execute({ expression: 'min(4, 2, 9) + max(1, 7)' })) as CalcResult;

    expect(result).toBe(9);
  });

  it.each([
    ['abs(-5)', 5],
    ['ceil(1.2)', 2],
    ['floor(1.8)', 1],
    ['round(2.5)', 3],
    ['sqrt(16)', 4],
  ])('evaluates function %s', async (expression, expected) => {
    const { result } = (await tool.execute({ expression })) as CalcResult;

    expect(result).toBe(expected);
  });

  it('parses numbers in scientific notation', async () => {
    const { result } = (await tool.execute({ expression: '1.5e3 + 2E2' })) as CalcResult;

    expect(result).toBe(1700);
  });

  it('rejects a malformed number', async () => {
    await expect(tool.execute({ expression: '1.2.3' })).rejects.toThrow(/Invalid expression/);
  });

  it('rejects an unknown function', async () => {
    await expect(tool.execute({ expression: 'wat(1)' })).rejects.toThrow(/unknown function/);
  });

  it('rejects a function called with the wrong arity', async () => {
    await expect(tool.execute({ expression: 'sqrt(1, 2)' })).rejects.toThrow(/expects 1 argument/);
  });

  it('rejects a variadic function called with no arguments', async () => {
    await expect(tool.execute({ expression: 'max()' })).rejects.toThrow(/at least one argument/);
  });

  it('rejects a string literal as invalid syntax', async () => {
    await expect(tool.execute({ expression: '"abc"' })).rejects.toThrow(/Invalid expression/);
  });

  it('rejects a trailing token', async () => {
    await expect(tool.execute({ expression: '1 2' })).rejects.toThrow(/Invalid expression/);
  });

  it('rejects an unbalanced parenthesis', async () => {
    await expect(tool.execute({ expression: '(1 + 2' })).rejects.toThrow(/Invalid expression/);
  });

  it('rejects non-numeric variables via the schema', async () => {
    await expect(
      tool.execute({ expression: 'a', variables: { a: 'one' } }),
    ).rejects.toThrow();
  });
});

describe('createJsonTransformTool', () => {
  const tool = createJsonTransformTool();
  const order = { id: 'o-1', total: 42, customer: { name: 'Ada' } };

  it('declares the json_transform name without taint', () => {
    expect(tool.name).toBe('json_transform');
    expect(tool.taints).toBe(false);
  });

  it('resolves a dot path', async () => {
    const { result } = (await tool.execute({
      data: order,
      path: 'customer.name',
    })) as TransformResult;

    expect(result).toBe('Ada');
  });

  it('resolves bracket indexing into arrays', async () => {
    const { result } = (await tool.execute({
      data: { orders: [order, { id: 'o-2', total: 7 }] },
      path: 'orders[1].total',
    })) as TransformResult;

    expect(result).toBe(7);
  });

  it('picks a key subset from an object', async () => {
    const { result } = (await tool.execute({
      data: order,
      pick: ['id', 'total'],
    })) as TransformResult;

    expect(result).toEqual({ id: 'o-1', total: 42 });
  });

  it('picks a key subset from each element of an array', async () => {
    const { result } = (await tool.execute({
      data: [order, { id: 'o-2', total: 7, customer: { name: 'Grace' } }],
      pick: ['id'],
    })) as TransformResult;

    expect(result).toEqual([{ id: 'o-1' }, { id: 'o-2' }]);
  });

  it('parses a JSON string before transforming', async () => {
    const { result } = (await tool.execute({
      data: JSON.stringify(order),
      path: 'total',
    })) as TransformResult;

    expect(result).toBe(42);
  });

  it('rejects a string that is not valid JSON', async () => {
    await expect(tool.execute({ data: 'not json', path: 'a' })).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('returns null for a path that resolves to nothing', async () => {
    const { result } = (await tool.execute({
      data: order,
      path: 'customer.missing.deep',
    })) as TransformResult;

    expect(result).toBeNull();
  });
});
