<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Service\ImageGeneration;

use Paith\Notes\Api\Http\HttpError;

/**
 * Resolves the ImageGenerator implementation from env. This is the
 * one place a swap from OpenAI → FLUX/Imagen/local model lands:
 * add a case to the switch, set IMAGE_PROVIDER, done.
 *
 * Tests set IMAGE_PROVIDER=fake (or omit OPENAI_API_KEY) to get a
 * deterministic no-network FakeImageGenerator without monkeypatching.
 *
 * Env contract:
 *   IMAGE_PROVIDER  openai|fake (default: fake if no key, openai if key set)
 *   IMAGE_MODEL     model id for the provider (default per-provider)
 *   OPENAI_API_KEY  required when provider=openai
 */
final class ImageGeneratorFactory
{
    public static function fromEnv(): ImageGenerator
    {
        $provider = strtolower(trim((string)getenv('IMAGE_PROVIDER')));

        // Implicit default: fake when no upstream credentials are in
        // the env (dev container, CI). Avoids forcing test setups to
        // export IMAGE_PROVIDER explicitly.
        if ($provider === '') {
            $provider = ((string)getenv('OPENAI_API_KEY') !== '') ? 'openai' : 'fake';
        }

        return match ($provider) {
            'openai' => self::makeOpenAi(),
            'fake' => new FakeImageGenerator(),
            default => throw new HttpError("unknown IMAGE_PROVIDER: {$provider}", 500),
        };
    }

    private static function makeOpenAi(): OpenAiImageGenerator
    {
        $key = trim((string)getenv('OPENAI_API_KEY'));
        $model = trim((string)getenv('IMAGE_MODEL'));
        if ($model === '') {
            $model = 'gpt-image-1';
        }
        return new OpenAiImageGenerator($key, $model, new CurlHttpTransport());
    }
}
