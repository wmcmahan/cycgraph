import { createAnthropic } from '@ai-sdk/anthropic';

const sse = [
  { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 800 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const fakeFetch: typeof fetch = async () =>
  new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });

const anthropic = createAnthropic({ apiKey: 'sk-ant-fake', fetch: fakeFetch });
const model = anthropic('claude-opus-5');

const { stream } = await (model as unknown as { doStream: (o: unknown) => Promise<{ stream: ReadableStream }> }).doStream({
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  includeRawChunks: false,
});

const reader = stream.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const part = value as { type: string; usage?: unknown };
  if (part.type === 'finish' || part.type === 'stream-start') {
    console.log(part.type, ':', JSON.stringify(part.usage ?? {}));
  }
}
