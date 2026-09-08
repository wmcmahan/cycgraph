import { streamText, tool, isStepCount } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { cachePrepareStep } from '../dist/agents/executors/agent/executor.js';

const usage = {
  inputTokens: { total: 1000, noCache: 100, cacheRead: 800, cacheWrite: 100 },
  outputTokens: { total: 50, text: 50 },
};
let call = 0;
const model = new MockLanguageModelV4({
  doStream: async () => {
    call += 1;
    const chunks = call === 1
      ? [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"id":"a"}' },
          { type: 'finish', finishReason: 'tool-calls', usage },
        ]
      : [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'DONE' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage },
        ];
    return { stream: simulateReadableStream({ chunks }) };
  },
});

const lookup = tool({
  description: 'lookup',
  inputSchema: z.object({ id: z.string() }),
  execute: async ({ id }: { id: string }) => `record ${id}`,
});

const result = streamText({
  model: model as never,
  system: 'sys',
  prompt: 'go',
  tools: { lookup },
  stopWhen: isStepCount(4),
  prepareStep: cachePrepareStep as never,
});
for await (const _ of result.textStream) { /* drain */ }

const totalUsage = await result.totalUsage;
console.log('totalUsage public shape:', JSON.stringify(totalUsage, null, 1));
console.log('doStream calls:', model.doStreamCalls.length);
model.doStreamCalls.forEach((options: { prompt: unknown }, index: number) => {
  const json = JSON.stringify(options.prompt);
  const markers = (json.match(/cacheControl|cache_control/g) ?? []).length;
  console.log(`request ${index + 1}: markers in received prompt = ${markers}`);
  if (index === model.doStreamCalls.length - 1) {
    console.log('last request prompt tail:', json.slice(-600));
  }
});
