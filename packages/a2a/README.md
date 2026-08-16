# @cycgraph/a2a

Official Agent2Agent (A2A) adapter for `@cycgraph/orchestrator`.

The orchestrator defines a narrow `A2AClient` port and carries no protocol
dependency. This package implements that port on the official
[`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk), so a graph can
delegate a step to a remote agent with an `a2a` node.

## Install

```bash
npm install @cycgraph/a2a @cycgraph/orchestrator
```

## Usage

Remote endpoints live in a trusted registry, never in the graph. A graph
names a `server_id`; the registry resolves the Agent Card URL and
credentials at call time. This means an LLM-authored graph cannot point the
engine at an arbitrary host.

```typescript
import { a2a, graph, run, InMemoryA2AServerRegistry } from '@cycgraph/orchestrator';
import { createA2AClient } from '@cycgraph/a2a';

const registry = new InMemoryA2AServerRegistry();
await registry.saveServer({
  id: 'research-service',
  name: 'Research Service',
  agentCardUrl: 'https://agents.example.com/.well-known/agent-card.json',
  auth: { type: 'bearer', tokenEnv: 'RESEARCH_SERVICE_TOKEN' },
});

const briefing = graph({
  name: 'briefing',
  nodes: [
    a2a('research-service', {
      id: 'research',
      reads: ['topic'],
      inputs:  { topic: 'query' },
      outputs: { report: 'findings' },
    }),
  ],
});

const { findings } = await run(briefing, {
  goal: 'Research the topic.',
  memory: { topic: 'solid-state batteries' },
}, {
  runner: { a2aRegistry: registry, a2aClient: createA2AClient() },
});
```

Credentials are named environment variables, never literal values. A
registry row holds no secret, so a database dump or a `listServers()`
response cannot leak one.

## What the engine guarantees at the boundary

- Everything a remote agent returns is recorded in the taint registry as
  external data, and the marking survives subgraph composition.
- A task that ends `rejected` or `auth-required` is not retried. The agent
  decided, or the credential cannot change mid-run.
- A task that stops in `input-required` pauses the workflow through the
  same human-in-the-loop machinery an approval node uses. The answer
  resumes the same remote task rather than starting a new one, including
  when the `a2a` node sits inside a subgraph.
- Budget and capability ceilings stop at the network. Remote spend is
  unmetered, bounded only by timeouts and the failure policy.

## Trace context

Set `propagateTraceContext: true` on a registry entry to send W3C
`traceparent` headers, joining the remote agent's work to your trace. It is
off by default because it discloses your trace id to the receiving party.

## Testing

Unit tests run against an injected stub and need no network. The
composition suite in `test/composition.test.ts` runs live against the
scenario servers in `@cycgraph/test-servers` and skips unless
`A2A_SCENARIO_SERVER` is set:

```bash
docker-compose --profile playground up -d scenario-servers
A2A_SCENARIO_SERVER=http://127.0.0.1:4001 npx vitest run test/composition.test.ts
```

Without Docker, run the servers directly in another shell instead:

```bash
npm run start --workspace=packages/test-servers
```

## Limitations

- Verified against the scenario servers in this repository, which are built
  on the official SDK, and not yet against an independent third-party
  agent. Whether real agents use `input-required` and `rejected` faithfully
  is unconfirmed.
- The polling path for tasks that return while still `working` is covered
  by unit tests only; no scenario server currently exercises it live.
- This package is the consuming half. Serving a cycgraph graph as an A2A
  agent is planned separately; `toAgentCard` in the orchestrator already
  produces the card.
