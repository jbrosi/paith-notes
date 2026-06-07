<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Service\ImageGeneration\FakeImageGenerator;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGeneratorFactory;
use Paith\Notes\Api\Http\Service\ImageGeneration\OpenAiImageGenerator;

/**
 * Provider selection contract for the factory. Mutates env via
 * putenv() — restored after each test so cases stay isolated.
 */

beforeEach(function (): void {
    putenv('IMAGE_PROVIDER');
    putenv('IMAGE_MODEL');
    putenv('OPENAI_API_KEY');
});

afterEach(function (): void {
    putenv('IMAGE_PROVIDER');
    putenv('IMAGE_MODEL');
    putenv('OPENAI_API_KEY');
});

it('defaults to the fake generator when no provider and no key are set', function (): void {
    expect(ImageGeneratorFactory::fromEnv())->toBeInstanceOf(FakeImageGenerator::class);
});

it('auto-selects openai when an api key is present but no provider is set', function (): void {
    putenv('OPENAI_API_KEY=sk-test');
    expect(ImageGeneratorFactory::fromEnv())->toBeInstanceOf(OpenAiImageGenerator::class);
});

it('respects an explicit IMAGE_PROVIDER=fake even with a key set', function (): void {
    putenv('OPENAI_API_KEY=sk-test');
    putenv('IMAGE_PROVIDER=fake');
    expect(ImageGeneratorFactory::fromEnv())->toBeInstanceOf(FakeImageGenerator::class);
});

it('throws on an unknown provider rather than silently defaulting', function (): void {
    putenv('IMAGE_PROVIDER=midjourney');
    expect(fn() => ImageGeneratorFactory::fromEnv())
        ->toThrow(HttpError::class, 'unknown IMAGE_PROVIDER: midjourney');
});

it('throws when openai is selected but no api key is configured', function (): void {
    putenv('IMAGE_PROVIDER=openai');
    expect(fn() => ImageGeneratorFactory::fromEnv())
        ->toThrow(HttpError::class, 'OPENAI_API_KEY is not configured');
});
