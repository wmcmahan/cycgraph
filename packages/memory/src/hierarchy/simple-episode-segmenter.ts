/**
 * Simple Episode Segmenter
 *
 * Rule-based segmentation: splits messages into episodes based on
 * time gaps between consecutive messages. No LLM required.
 *
 * @module hierarchy/simple-episode-segmenter
 */

import type { Message, Episode } from '../schemas/episode.js';
import type { EpisodeSegmenter } from '../interfaces/episode-segmenter.js';

export interface SimpleEpisodeSegmenterOptions {
  /** Time gap threshold in milliseconds (default: 5 minutes). */
  gapThresholdMs?: number;
  /** Maximum topic label length (default: 100). */
  maxTopicLength?: number;
}

export class SimpleEpisodeSegmenter implements EpisodeSegmenter {
  private readonly gapThresholdMs: number;
  private readonly maxTopicLength: number;

  constructor(opts: SimpleEpisodeSegmenterOptions = {}) {
    this.gapThresholdMs = opts.gapThresholdMs ?? 5 * 60 * 1000;
    this.maxTopicLength = opts.maxTopicLength ?? 100;
  }

  async segment(messages: Message[]): Promise<Episode[]> {
    if (messages.length === 0) return [];

    const sorted = [...messages].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );

    const episodes: Episode[] = [];
    let currentGroup: Message[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].timestamp.getTime() - sorted[i - 1].timestamp.getTime();

      if (gap > this.gapThresholdMs) {
        episodes.push(this.buildEpisode(currentGroup));
        currentGroup = [sorted[i]];
      } else {
        currentGroup.push(sorted[i]);
      }
    }

    // Final group
    if (currentGroup.length > 0) {
      episodes.push(this.buildEpisode(currentGroup));
    }

    return episodes;
  }

  private buildEpisode(messages: Message[]): Episode {
    const topic = messages[0].content.slice(0, this.maxTopicLength);
    const now = new Date();

    return {
      id: crypto.randomUUID(),
      topic,
      messages,
      started_at: messages[0].timestamp,
      ended_at: messages[messages.length - 1].timestamp,
      fact_ids: [],
      provenance: {
        source: 'system',
        created_at: now,
      },
    };
  }
}
