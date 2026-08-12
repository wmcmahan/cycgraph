import type { ContextCompressor } from '@cycgraph/orchestrator';
import { createOptimizedPipeline, resolveModelProfile } from '@cycgraph/context-engine';

const DEFAULT_OUTPUT_RESERVE = 8_192;

const pipeline = createOptimizedPipeline({ preset: 'balanced' });

export const contextCompressor: ContextCompressor = (segments, options) => {
    const result = pipeline.compress({
        segments: segments.map((segment) => ({
            id: segment.id,
            content: segment.content,
            role: segment.role,
            priority: segment.priority ?? 1,
            locked: segment.locked ?? false,
        })),
        budget: {
            maxTokens: options?.maxTokens ?? resolveModelProfile(options?.model)?.maxContextTokens ?? 8192,
            outputReserve: options?.outputReserve ?? DEFAULT_OUTPUT_RESERVE,
        },
        query: options?.query,
        model: options?.model,
    });

    return {
        segments: result.segments.map((segment) => ({ id: segment.id, content: segment.content })),
        metrics: result.metrics,
    };
};