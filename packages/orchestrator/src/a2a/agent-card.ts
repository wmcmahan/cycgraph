/**
 * Agent Card Projection
 *
 * Renders a graph as the Agent Card a remote caller reads to decide whether
 * and how to invoke it. The inverse of the `a2a` node: that one consumes a
 * card, this one publishes one.
 *
 * The card shape is declared here rather than imported from a protocol SDK,
 * for the same reason `A2AClient` is a port — this produces plain data, and
 * core carries no A2A dependency. A serving package serves what this
 * returns.
 *
 * ## The projection is lossy, and only in one direction
 *
 * A graph's declared interface is a STRONGER contract than a card can
 * express. `inputs` / `outputs` carry per-key JSON Schema with derived
 * `required`; `AgentSkill` carries `inputModes` / `outputModes`, which are
 * MIME types. Modality, not shape.
 *
 * So a caller reading the card learns less than the graph actually
 * guarantees, and nothing here can fix that without inventing a protocol
 * extension. What this module does instead is refuse to *pretend*: the
 * declared schemas are rendered into the skill description, where a human
 * or an LLM choosing an agent will at least see them, and
 * {@link agentCardFidelity} reports what could not be expressed so a
 * publisher can decide whether that matters.
 *
 * @module a2a/agent-card
 */

import type { Graph } from '../graph/graph.js';
import type { GraphBundle } from '../authoring/bundle-schema.js';
import { isGraphBundle } from '../authoring/bundle-schema.js';

/** One protocol binding a served agent is reachable at. */
export interface AgentInterfaceDescriptor {
  /** Absolute URL. HTTPS in production. */
  url: string;
  /** Binding name. `JSONRPC`, `GRPC`, and `HTTP+JSON` are the core ones. */
  transport: string;
}

/** A capability a served agent advertises. */
export interface AgentSkillDescriptor {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

/** The published card, as plain data. */
export interface AgentCardDescriptor {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: AgentInterfaceDescriptor[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkillDescriptor[];
  provider?: { organization: string; url: string };
  documentationUrl?: string;
}

/** Publication details a graph does not carry. */
export interface AgentCardOptions {
  /** Where the agent is reachable. At least one entry. */
  interfaces: AgentInterfaceDescriptor[];
  /** Version to publish. Taken from a bundle manifest when absent. */
  version?: string;
  /** Optional provider block. */
  provider?: { organization: string; url: string };
  /** Optional link to human documentation. */
  documentationUrl?: string;
}

/** MIME types a graph boundary speaks: JSON for data, text for prose. */
const DEFAULT_MODES = ['application/json', 'text/plain'];

/**
 * Render a declared interface as readable lines for the skill description.
 *
 * This is the only place the schemas survive into the card at all, so it is
 * worth being explicit rather than terse: a caller cannot validate against
 * them, but can at least see what is expected.
 */
function describeInterface(graph: Graph): string {
  const lines: string[] = [];

  if (graph.inputs && Object.keys(graph.inputs).length > 0) {
    lines.push('Inputs:');
    for (const [key, decl] of Object.entries(graph.inputs)) {
      const optional = decl.required ? '' : ' (optional)';
      const description = decl.description ? ` — ${decl.description}` : '';
      lines.push(`  ${key}${optional}: ${schemaSummary(decl.schema)}${description}`);
    }
  }

  if (graph.outputs && Object.keys(graph.outputs).length > 0) {
    lines.push('Outputs:');
    for (const [key, decl] of Object.entries(graph.outputs)) {
      const description = decl.description ? ` — ${decl.description}` : '';
      lines.push(`  ${key}: ${schemaSummary(decl.schema)}${description}`);
    }
  }

  return lines.join('\n');
}

/** A one-line rendering of a JSON Schema, enough to read at a glance. */
function schemaSummary(schema: Record<string, unknown>): string {
  const type = schema.type;
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.join(' | ')})`;
  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined;
    return `array<${items ? schemaSummary(items) : 'any'}>`;
  }
  return typeof type === 'string' ? type : 'object';
}

/**
 * Project a graph, or a bundle, into an Agent Card.
 *
 * A graph publishes exactly ONE skill. Skills are how a card advertises
 * alternative capabilities, and a graph is a single unit of work with one
 * declared interface — splitting it would imply a choice the graph does not
 * offer.
 *
 * @param source - The graph to publish, or a bundle wrapping it.
 * @param options - Endpoint, version, and provenance the graph lacks.
 */
export function toAgentCard(
  source: Graph | GraphBundle,
  options: AgentCardOptions,
): AgentCardDescriptor {
  if (options.interfaces.length === 0) {
    throw new Error('toAgentCard requires at least one interface: a card with no endpoint is unusable');
  }

  const bundle = isGraphBundle(source) ? source : undefined;
  const graph = bundle ? bundle.graph : (source as Graph);

  const version = options.version ?? bundle?.manifest.version;
  if (!version) {
    throw new Error(
      'toAgentCard requires a version: pass one explicitly, or publish a bundle, which carries it in its manifest',
    );
  }

  const name = bundle?.manifest.name ?? graph.name;
  const description = bundle?.manifest.description ?? graph.description ?? name;
  const interfaceDetail = describeInterface(graph);

  return {
    name,
    description,
    version,
    supportedInterfaces: options.interfaces,
    defaultInputModes: DEFAULT_MODES,
    defaultOutputModes: DEFAULT_MODES,
    skills: [{
      id: graph.id,
      name,
      description: interfaceDetail ? `${description}\n\n${interfaceDetail}` : description,
      tags: [],
      inputModes: DEFAULT_MODES,
      outputModes: DEFAULT_MODES,
    }],
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.documentationUrl ? { documentationUrl: options.documentationUrl } : {}),
  };
}

/** What a card could not carry across from a graph's declaration. */
export interface AgentCardFidelity {
  /** True when every declared key survived as an enforceable contract. */
  lossless: boolean;
  /** Declared input keys whose schema the card cannot express. */
  unexpressedInputs: string[];
  /** Declared output keys whose schema the card cannot express. */
  unexpressedOutputs: string[];
}

/**
 * Report what {@link toAgentCard} could not express.
 *
 * Every declared key is currently unexpressed, because no version of the
 * card format carries per-key schemas. That is not a defect to fix here; it
 * is a fact a publisher should be able to see before deciding to expose a
 * graph whose correctness depends on callers respecting those schemas.
 *
 * A graph declaring no interface is trivially lossless: there was nothing
 * to lose.
 */
export function agentCardFidelity(source: Graph | GraphBundle): AgentCardFidelity {
  const graph = isGraphBundle(source) ? source.graph : (source as Graph);
  const unexpressedInputs = Object.keys(graph.inputs ?? {});
  const unexpressedOutputs = Object.keys(graph.outputs ?? {});

  return {
    lossless: unexpressedInputs.length === 0 && unexpressedOutputs.length === 0,
    unexpressedInputs,
    unexpressedOutputs,
  };
}
