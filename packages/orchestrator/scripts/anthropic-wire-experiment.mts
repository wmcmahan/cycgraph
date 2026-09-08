import { createAnthropic } from '@ai-sdk/anthropic';

let captured = '';
const capture: typeof fetch = async (_input, init) => {
  captured = typeof init?.body === 'string' ? init.body : '';
  throw new Error('captured');
};

const anthropic = createAnthropic({ apiKey: 'sk-ant-fake', fetch: capture });
const model = anthropic('claude-opus-5');

// The exact provider-layer prompt the mock experiment captured, markers included.
const prompt = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: [{ type: 'text', text: 'go', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }] },
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { id: 'a' }, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'lookup', output: { type: 'text', value: 'record a' }, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }] },
];

try {
  await (model as unknown as { doStream: (o: unknown) => Promise<unknown> }).doStream({
    prompt,
    tools: [{ type: 'function', name: 'lookup', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }],
    includeRawChunks: false,
  });
} catch (error) {
  if ((error as Error).message !== 'captured' && captured === '') throw error;
}

const markers = (captured.match(/"cache_control"/g) ?? []).length;
console.log('outgoing body cache_control markers:', markers);
console.log('body excerpt:', captured.slice(0, 400));
if (markers === 0) console.log('\nVERDICT: the anthropic provider DROPS the markers during conversion.');
else console.log('\nVERDICT: markers survive to the wire — provider conversion is fine.');
