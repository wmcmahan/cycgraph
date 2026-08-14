# Ollama Local

A two-node pipeline running entirely against a local model. No API key, no
cost. The point is `registerOllamaProvider()`: the orchestrator ships no
Ollama SDK, so you inject the client factory and it registers onto a
run-scoped provider registry.

## Graph

```
research → research_notes
   └── write → draft
```

## Lifecycle & State

| Key | Written by |
| --- | --- |
| `research_notes` | research |
| `draft` | write |

## Run

Install [Ollama](https://ollama.com), pull a model, and make sure the server
is up:

```bash
ollama pull gemma2:9b
ollama serve
```

Then:

```bash
npx tsx examples/ollama-local/ollama-local.ts

# any pulled model:
OLLAMA_MODEL=qwen2.5:7b npx tsx examples/ollama-local/ollama-local.ts
```

| Variable | Default |
| --- | --- |
| `OLLAMA_BASE_URL` | `http://localhost:11434` |
| `OLLAMA_MODEL` | `gemma2:9b` |

## Expected Output

```
Status: completed
Tokens used: 1240
Cost (USD):  $0.0000
```

Cost is zero because local models carry no price entry.

## Notes

**Two client packages work.** Ollama speaks the OpenAI-compatible API, so
either official or community clients serve:

```ts
// @ai-sdk/openai-compatible
registerOllamaProvider(providers, ({ baseURL }) =>
  (modelId) => createOpenAICompatible({ name: 'ollama', baseURL, apiKey: 'ollama' }).chatModel(modelId));

// ollama-ai-provider-v2
registerOllamaProvider(providers, ({ baseURL }) => createOllama({ baseURL }));
```

The factory injection is why the orchestrator depends on neither.

**Every example can run this way.** Set `CYCGRAPH_MODEL` to any Ollama tag and
the shared `_model.ts` swaps both the model and the provider registration:

```bash
CYCGRAPH_MODEL=qwen2.5:7b npx tsx examples/supervisor-routing/supervisor-routing.ts
```

`npm run smoke` runs the whole suite that way.
