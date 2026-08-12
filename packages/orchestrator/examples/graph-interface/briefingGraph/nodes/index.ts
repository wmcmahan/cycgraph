import { node } from '@cycgraph/orchestrator';
import { briefAgent } from '../agents';

export const briefNode = node({
  id: 'brief',
  agent: briefAgent,
  reads: ['findings'],
  writes: 'executive_brief',
});
