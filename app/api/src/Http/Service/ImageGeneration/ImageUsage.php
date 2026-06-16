<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

/**
 * Token + cost telemetry for one image generation. Returned by the
 * provider when available — null otherwise (e.g. the test stub).
 *
 * Cost is the provider's computed USD estimate. For OpenAI this is
 * derived from gpt-image-1's published token rates; the API itself
 * doesn't return a dollar figure so we compute it in the impl.
 */
final readonly class ImageUsage
{
    public function __construct(
        public int $inputTokens,
        public int $outputTokens,
        public int $totalTokens,
        public float $estimatedCostUsd,
    ) {
    }

    /**
     * @return array{
     *     input_tokens: int,
     *     output_tokens: int,
     *     total_tokens: int,
     *     estimated_cost_usd: float,
     * }
     */
    public function toArray(): array
    {
        return [
            'input_tokens' => $this->inputTokens,
            'output_tokens' => $this->outputTokens,
            'total_tokens' => $this->totalTokens,
            'estimated_cost_usd' => round($this->estimatedCostUsd, 4),
        ];
    }
}
