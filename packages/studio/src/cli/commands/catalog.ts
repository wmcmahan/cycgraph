/**
 * The catalog-facing verbs: the bare listing, the stack banner, and one
 * scenario's parameter reference.
 *
 * @module cli/commands/catalog
 */

import { describeParams } from '../../params/introspect.js';
import { availability } from '../../scenarios/catalog.js';
import { resolveStack } from '../../stack/index.js';
import type { CliContext } from '../context.js';
import { renderParams, renderScenarios, renderStack } from '../render.js';

export async function listCommand(ctx: CliContext): Promise<void> {
  const stack = await resolveStack(ctx.config);
  renderStack(stack);
  renderScenarios(availability(stack, ctx.catalog));
  await stack.close();
}

export async function stackCommand(ctx: CliContext): Promise<void> {
  const stack = await resolveStack(ctx.config);
  renderStack(stack);
  await stack.close();
}

export async function paramsCommand(ctx: CliContext): Promise<void> {
  const scenario = await ctx.requireScenario(ctx.args[0]);
  renderParams(describeParams(scenario.params));
}
