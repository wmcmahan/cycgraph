/**
 * Example smoke runner.
 *
 * Executes every example that can run headless and reports which completed.
 * These are real runs against a real model, which is the point: type checks
 * and graph validation both pass on a node whose agent has been granted no
 * write keys, and only a run shows the empty output.
 *
 * Defaults to a local Ollama model so a full sweep costs nothing:
 *
 *   npm run smoke --workspace=packages/orchestrator
 *   CYCGRAPH_MODEL=claude-sonnet-4-6 ANTHROPIC_API_KEY=… npm run smoke --workspace=packages/orchestrator
 *
 * Excluded, with the reason on each entry: examples needing stdin, a database,
 * or an MCP server are not smoke-testable without that dependency.
 *
 * @module examples/smoke
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Examples that verify engine wiring: node authoring, permissions, mappings,
 * fan-out, memory. A failure here is a real regression at any model size.
 */
const RUNNABLE = [
  'hardening-validation/hardening-validation.ts',
  'research-and-write/research-and-write.ts',
  'supervisor-routing/supervisor-routing.ts',
  'streaming/streaming.ts',
  'map-reduce/map-reduce.ts',
  'voting/voting.ts',
  'evolution/evolution.ts',
  'evolution-regex/evolution-regex.ts',
  'learning-research-agent/learning-research-agent.ts',
  'composition/composition.ts',
  'graph-interface/index.ts',
  'counterfactual-replay/counterfactual-replay.ts',
];

/**
 * Examples whose success depends on model capability rather than engine
 * correctness, with what each one needs. Run and reported, but they do not
 * fail the sweep: on a small local model they fail for reasons the engine
 * handles correctly and reports clearly.
 *
 * `eval-loop` is the illustrative case. Its evaluator must make three
 * `save_to_memory` calls to populate `score`, `feedback`, and `suggestions`.
 * Neither qwen2.5:7b nor gemma2:9b does that reliably, so the engine declines
 * to guess which of three keys an untagged response belongs to, `memory.score`
 * stays unset, and the loop runs to its iteration cap. Every step of that is
 * correct behaviour meeting an incapable model.
 */
const CAPABILITY_DEPENDENT: Array<[string, string]> = [
  ['eval-loop/eval-loop.ts', 'evaluator must make 3 reliable save_to_memory calls'],
  ['prompt-builder/prompt-builder.ts', 'annealing must converge within 30 iterations'],
  ['workflow-observer/run.ts', 'two full supervisor workflows inside a 120s cap'],
  ['verifier-fix-loop/verifier-fix-loop.ts', 'extraction must satisfy the verifier before the iteration cap'],
];

/** Why each excluded example cannot run in a headless sweep. */
const EXCLUDED: Record<string, string> = {
  'human-in-the-loop': 'reads a decision from stdin',
  'postgres-persistence': 'needs DATABASE_URL',
  'context-and-memory': 'needs DATABASE_URL',
  'mcp-integration': 'needs a reachable MCP server',
  'graph-interop': 'consumes a bundle written by publish.ts; run that first',
  'ollama-local': 'covered by every other example when CYCGRAPH_MODEL is local',
  'evals': 'exercised by the evals package suite',
};

const TIMEOUT_MS = Number(process.env['SMOKE_TIMEOUT_MS'] ?? 300_000);

function run(rel: string): Promise<{ rel: string; ok: boolean; detail: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npx', ['tsx', join(HERE, rel)], {
      cwd: join(HERE, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    let stdoutTail = '';
    child.stdout?.on('data', (b: Buffer) => {
      stdoutTail = (stdoutTail + b.toString()).slice(-4000);
    });
    child.stderr?.on('data', (b: Buffer) => {
      stderrTail = (stderrTail + b.toString()).slice(-2000);
    });

    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === 0) {
        // Exiting clean is not proof of work. An example whose model calls all
        // failed can still finish and report nothing, which is how a
        // misconfigured provider slipped through as a pass.
        const noWork = /Tokens used:\s*0\b/.test(stdoutTail);
        return noWork
          ? resolve({ rel, ok: false, detail: 'exited 0 but used 0 tokens — no model call landed', ms })
          : resolve({ rel, ok: true, detail: '', ms });
      }
      const line = stderrTail
        .split('\n')
        .reverse()
        .find((l) => /error|Error|FAIL/.test(l))
        ?.trim()
        .slice(0, 160);
      resolve({ rel, ok: false, detail: line ?? `exit ${code}`, ms });
    });
  });
}

// An example absent from all three lists is silently never run and never
// reported as skipped. `verifier-fix-loop` sat in that gap while it carried two
// routing bugs, so completeness is checked rather than assumed.
const listed = new Set([
  ...RUNNABLE.map((p) => p.split('/')[0]),
  ...CAPABILITY_DEPENDENT.map(([p]) => p.split('/')[0]),
  ...Object.keys(EXCLUDED),
]);
const unlisted = readdirSync(join(HERE), { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
  .map((e) => e.name)
  .filter((name) => !listed.has(name));

if (unlisted.length > 0) {
  console.error(`Examples in no list: ${unlisted.join(', ')}`);
  console.error('Add each to RUNNABLE, CAPABILITY_DEPENDENT, or EXCLUDED.');
  process.exit(1);
}

const model = process.env['CYCGRAPH_MODEL'] ?? 'claude-sonnet-4-6';
console.log(`Smoke-running ${RUNNABLE.length} examples against ${model}\n`);

const results = [];
for (const rel of RUNNABLE) {
  process.stdout.write(`  ${rel.padEnd(52)}`);
  const r = await run(rel);
  results.push(r);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${(r.ms / 1000).toFixed(1)}s${r.detail ? `  ${r.detail}` : ''}`);
}

console.log('\nCapability-dependent (reported, not gating):');
for (const [rel, needs] of CAPABILITY_DEPENDENT) {
  process.stdout.write(`  ${rel.padEnd(52)}`);
  const r = await run(rel);
  console.log(`${r.ok ? 'PASS' : 'SKIP'}  ${(r.ms / 1000).toFixed(1)}s  ${r.ok ? '' : needs}`);
}

console.log('\nExcluded:');
for (const [name, why] of Object.entries(EXCLUDED)) console.log(`  ${name.padEnd(24)} ${why}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
