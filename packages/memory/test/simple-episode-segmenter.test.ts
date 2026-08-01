/**
 * Tests for hierarchy/simple-episode-segmenter: time-gap segmentation of a
 * message stream into episodes, with topic derivation and truncation.
 */

import { describe, it, expect } from 'vitest';
import { SimpleEpisodeSegmenter } from '../src/hierarchy/simple-episode-segmenter.js';
import { FIXED_DATE, makeMessage } from './helpers.js';

function at(offsetMs: number): Date {
  return new Date(FIXED_DATE.getTime() + offsetMs);
}

const MINUTE = 60 * 1000;

describe('SimpleEpisodeSegmenter', () => {
  it('returns no episodes for an empty message list', async () => {
    const segmenter = new SimpleEpisodeSegmenter();

    const episodes = await segmenter.segment([]);

    expect(episodes).toHaveLength(0);
  });

  it('places a single message in one episode', async () => {
    const segmenter = new SimpleEpisodeSegmenter();
    const message = makeMessage({ content: 'Only message', timestamp: FIXED_DATE });

    const episodes = await segmenter.segment([message]);

    expect(episodes).toHaveLength(1);
    expect(episodes[0].messages).toEqual([message]);
    expect(episodes[0].started_at).toEqual(FIXED_DATE);
    expect(episodes[0].ended_at).toEqual(FIXED_DATE);
  });

  it('groups messages within the gap threshold into one episode', async () => {
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 5 * MINUTE });
    const messages = [
      makeMessage({ content: 'First', timestamp: at(0) }),
      makeMessage({ content: 'Second', timestamp: at(MINUTE) }),
      makeMessage({ content: 'Third', timestamp: at(2 * MINUTE) }),
    ];

    const episodes = await segmenter.segment(messages);

    expect(episodes).toHaveLength(1);
    expect(episodes[0].messages).toHaveLength(3);
    expect(episodes[0].ended_at).toEqual(at(2 * MINUTE));
  });

  it('splits into separate episodes when a gap exceeds the threshold', async () => {
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 5 * MINUTE });
    const messages = [
      makeMessage({ content: 'Session one', timestamp: at(0) }),
      makeMessage({ content: 'Still one', timestamp: at(MINUTE) }),
      makeMessage({ content: 'Session two', timestamp: at(60 * MINUTE) }),
    ];

    const episodes = await segmenter.segment(messages);

    expect(episodes).toHaveLength(2);
    expect(episodes[0].messages).toHaveLength(2);
    expect(episodes[1].messages).toHaveLength(1);
    expect(episodes[1].topic).toBe('Session two');
  });

  it('sorts out-of-order messages by timestamp before segmenting', async () => {
    const segmenter = new SimpleEpisodeSegmenter({ gapThresholdMs: 5 * MINUTE });
    const messages = [
      makeMessage({ content: 'Later', timestamp: at(2 * MINUTE) }),
      makeMessage({ content: 'Earliest', timestamp: at(0) }),
      makeMessage({ content: 'Middle', timestamp: at(MINUTE) }),
    ];

    const episodes = await segmenter.segment(messages);

    expect(episodes).toHaveLength(1);
    expect(episodes[0].topic).toBe('Earliest');
    expect(episodes[0].started_at).toEqual(at(0));
    expect(episodes[0].ended_at).toEqual(at(2 * MINUTE));
  });

  it('derives the topic from the first message content', async () => {
    const segmenter = new SimpleEpisodeSegmenter();
    const message = makeMessage({ content: 'Deploy plan review', timestamp: FIXED_DATE });

    const episodes = await segmenter.segment([message]);

    expect(episodes[0].topic).toBe('Deploy plan review');
  });

  it('truncates the topic to maxTopicLength', async () => {
    const segmenter = new SimpleEpisodeSegmenter({ maxTopicLength: 10 });
    const message = makeMessage({ content: 'This content is definitely longer than ten', timestamp: FIXED_DATE });

    const episodes = await segmenter.segment([message]);

    expect(episodes[0].topic).toBe('This conte');
  });
});
