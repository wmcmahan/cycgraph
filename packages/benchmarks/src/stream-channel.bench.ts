/**
 * StreamChannel Throughput
 *
 * The channel sits in the hot path of `stream()`. It owns:
 *   - pending events (FIFO queue drained between yields)
 *   - token channel (high-frequency LLM token deltas)
 *   - single-slot notify primitive (Promise-based wake-up)
 *
 * If any of these regresses, every streaming workflow gets slower in a way
 * that's hard to attribute. These benches pin the cost.
 *
 * Run: `npm run bench --workspace=packages/benchmarks`
 */

import { bench, describe } from 'vitest';
import { StreamChannel, type StreamEvent } from '@cycgraph/orchestrator';

function makeTokenEvent(token: string): StreamEvent {
  return {
    type: 'agent:token_delta',
    run_id: '00000000-0000-0000-0000-000000000000',
    node_id: 'n',
    token,
    timestamp: Date.now(),
  };
}

function makePendingEvent(): StreamEvent {
  return {
    type: 'state:persisted',
    run_id: '00000000-0000-0000-0000-000000000000',
    iteration: 1,
    timestamp: Date.now(),
  };
}

describe('StreamChannel — pending queue', () => {
  bench('push 100 pending events + drain', () => {
    const channel = new StreamChannel();
    for (let i = 0; i < 100; i++) {
      channel.pushPending(makePendingEvent());
    }
    let count = 0;
    for (const _event of channel.drainPending()) {
      count++;
    }
    if (count !== 100) throw new Error('drain count mismatch');
  });

  bench('push 1000 pending events + drain', () => {
    const channel = new StreamChannel();
    for (let i = 0; i < 1000; i++) {
      channel.pushPending(makePendingEvent());
    }
    let count = 0;
    for (const _event of channel.drainPending()) {
      count++;
    }
    if (count !== 1000) throw new Error('drain count mismatch');
  });
});

describe('StreamChannel — token channel', () => {
  bench('push 1000 tokens + drain (no notify waiter)', () => {
    const channel = new StreamChannel();
    for (let i = 0; i < 1000; i++) {
      channel.pushToken(makeTokenEvent(`t${i}`));
    }
    let count = 0;
    for (const _event of channel.drainTokens()) {
      count++;
    }
    if (count !== 1000) throw new Error('drain count mismatch');
  });

  bench('push token + drain interleaved (1000 cycles)', () => {
    const channel = new StreamChannel();
    for (let i = 0; i < 1000; i++) {
      channel.pushToken(makeTokenEvent(`t${i}`));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for (const _e of channel.drainTokens()) { /* drain */ }
    }
  });
});

describe('StreamChannel — notify wake-up', () => {
  // The async notify primitive is on the hot path: every iteration of
  // executeNodeAndDrainTokens awaits notify between drains. We measure
  // the cost of a single create-wait-resolve cycle.
  bench('waitForNotify + notify (1000 cycles)', async () => {
    const channel = new StreamChannel();
    for (let i = 0; i < 1000; i++) {
      const p = channel.waitForNotify();
      channel.notify();
      await p;
    }
  });
});
