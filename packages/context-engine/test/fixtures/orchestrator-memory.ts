/**
 * Test Fixtures — Representative Orchestrator Memory Payloads
 *
 * These fixtures model the kind of data that `buildSystemPrompt()`
 * in the orchestrator serializes via `JSON.stringify(memory, null, 2)`.
 *
 * @module test/fixtures/orchestrator-memory
 */

export const supervisorHistory = [
  {
    supervisor_id: 'sup-abc123',
    delegated_to: 'research-agent',
    reasoning: 'The user query requires factual research before we can draft a response. Delegating to the research specialist.',
    iteration: 1,
    timestamp: '2026-04-05T10:00:00.000Z',
  },
  {
    supervisor_id: 'sup-abc123',
    delegated_to: 'research-agent',
    reasoning: 'The research agent needs to gather more information about the second topic mentioned in the query.',
    iteration: 2,
    timestamp: '2026-04-05T10:01:00.000Z',
  },
  {
    supervisor_id: 'sup-abc123',
    delegated_to: 'writer-agent',
    reasoning: 'Research is complete. The writer agent should now synthesize the findings into a coherent response.',
    iteration: 3,
    timestamp: '2026-04-05T10:02:00.000Z',
  },
  {
    supervisor_id: 'sup-abc123',
    delegated_to: 'reviewer-agent',
    reasoning: 'The draft is ready for review. The reviewer should check for accuracy and completeness.',
    iteration: 4,
    timestamp: '2026-04-05T10:03:00.000Z',
  },
  {
    supervisor_id: 'sup-abc123',
    delegated_to: 'writer-agent',
    reasoning: 'The reviewer identified some issues. Sending back to the writer for revisions.',
    iteration: 5,
    timestamp: '2026-04-05T10:04:00.000Z',
  },
];

export const agentMemoryDump = {
  research_results: {
    topic: 'Agentic AI Cost Optimization',
    sources: [
      { title: 'Amazon Science Blog', url: 'https://amazon.science/blog/cost-optimization', relevance: 0.92 },
      { title: 'DeepSeek V3 Technical Report', url: 'https://arxiv.org/abs/2401.00001', relevance: 0.88 },
      { title: 'LLMLingua: Compressing Prompts', url: 'https://arxiv.org/abs/2310.05736', relevance: 0.95 },
    ],
    key_findings: [
      'Multi-agent systems cost 5-10x more than single-agent, not 2x',
      'Task decomposition with smaller LLMs yields 70-90% cost reduction',
      'Smart context management has outsized impact on small model performance',
      'Most teams can cut 60-80% of costs with proper optimization',
    ],
    confidence: 0.87,
  },
  draft_response: 'Based on our research, the key strategies for reducing agentic AI costs include: (1) Task decomposition to route simpler subtasks to smaller models, (2) Context compression to reduce token usage by 40-60%, and (3) Caching frequently used prompt prefixes to take advantage of provider discounts.',
  review_feedback: {
    score: 0.78,
    issues: [
      'Missing specific cost figures from the Amazon Science blog',
      'Should mention the sovereign AI use case for local deployment',
    ],
    approved: false,
  },
};

export const fullWorkflowMemory = {
  supervisor_history: supervisorHistory,
  research_agent: agentMemoryDump.research_results,
  writer_agent: { output: agentMemoryDump.draft_response },
  reviewer_agent: agentMemoryDump.review_feedback,
  workflow_metadata: {
    started_at: '2026-04-05T10:00:00.000Z',
    total_iterations: 5,
    agents_used: ['research-agent', 'writer-agent', 'reviewer-agent'],
    estimated_cost_usd: 0.0342,
  },
};

export const memoryWithDuplicates = {
  agent_a_findings: 'Multi-agent systems cost 5-10x more than single-agent setups.\n\nTask decomposition with smaller LLMs yields 70-90% cost reduction.\n\nSmart context management has outsized impact on small model performance.',
  agent_b_findings: 'Multi-agent systems cost 5-10x more than single-agent setups.\n\nLocal deployment reduces latency and improves data sovereignty.\n\nSmart context management has outsized impact on small model performance.',
};
