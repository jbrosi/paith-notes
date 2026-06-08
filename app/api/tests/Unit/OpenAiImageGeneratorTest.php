<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Service\ImageGeneration\HttpTransport;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGenerationOptions;
use Paith\Notes\Api\Http\Service\ImageGeneration\OpenAiImageGenerator;

/**
 * Request shape + response parsing for the OpenAI generator, with
 * the HTTP transport stubbed so no network is required and the
 * outgoing request can be asserted on.
 */

/**
 * @param array{status: int, body: string} $canned
 * @return array{transport: HttpTransport, calls: array<int, array{url: string, headers: array<string, string>, body: string}>}
 */
function stubTransport(array $canned): array
{
    /** @var list<array{url: string, headers: array<string, string>, body: string}> $calls */
    $calls = [];

    $transport = new class ($canned, $calls) implements HttpTransport {
        /**
         * @param array{status: int, body: string} $canned
         * @param list<array{url: string, headers: array<string, string>, body: string}> $calls
         */
        public function __construct(
            private array $canned,
            public array &$calls,
        ) {
        }

        public function postJson(string $url, array $headers, string $jsonBody, int $timeoutSeconds): array
        {
            $this->calls[] = ['url' => $url, 'headers' => $headers, 'body' => $jsonBody];
            return $this->canned;
        }
    };

    return ['transport' => $transport, 'calls' => &$transport->calls];
}

it('rejects an empty prompt before hitting the network', function (): void {
    $stub = stubTransport(['status' => 200, 'body' => '{}']);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    expect(fn() => $gen->generate('   ', new ImageGenerationOptions()))
        ->toThrow(HttpError::class, 'prompt must be a non-empty string');
    expect($stub['calls'])->toBe([]);
});

it('requires an api key', function (): void {
    expect(fn() => new OpenAiImageGenerator('', 'gpt-image-1', stubTransport(['status' => 200, 'body' => '{}'])['transport']))
        ->toThrow(HttpError::class, 'OPENAI_API_KEY is not configured');
});

it('posts model+prompt+size+background and an auth header', function (): void {
    $bytes = base64_encode('PNGDATA');
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => $bytes, 'revised_prompt' => 'A revised version']]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    $img = $gen->generate('a cat', new ImageGenerationOptions(size: '512x512', transparent: true, quality: 'high'));

    expect($stub['calls'])->toHaveCount(1);
    $call = $stub['calls'][0];
    expect($call['url'])->toBe('https://api.openai.com/v1/images/generations');
    expect($call['headers']['Authorization'])->toBe('Bearer sk-test');
    expect($call['headers']['Content-Type'])->toBe('application/json');

    $decoded = json_decode($call['body'], true);
    expect($decoded)->toMatchArray([
        'model' => 'gpt-image-1',
        'prompt' => 'a cat',
        'n' => 1,
        'size' => '512x512',
        'background' => 'transparent',
        'quality' => 'high',
    ]);

    expect($img->bytes)->toBe('PNGDATA');
    expect($img->mimeType)->toBe('image/png');
    expect($img->revisedPrompt)->toBe('A revised version');
    expect($img->providerModel)->toBe('openai/gpt-image-1');
});

it('omits the quality field when not requested so OpenAI uses its own default', function (): void {
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => base64_encode('X')]]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    $gen->generate('a cat', new ImageGenerationOptions(quality: null));

    $body = json_decode($stub['calls'][0]['body'], true);
    expect($body)->not->toHaveKey('quality');
});

it('falls back to defaults when no options are supplied', function (): void {
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => base64_encode('X')]]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    $gen->generate('a fox', new ImageGenerationOptions());

    $body = json_decode($stub['calls'][0]['body'], true);
    expect($body['size'])->toBe('1024x1024');
    expect($body['background'])->toBe('opaque');
    expect($body)->not->toHaveKey('quality');
});

it('leaves revised_prompt as null when the provider does not return one', function (): void {
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => base64_encode('X')]]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    $img = $gen->generate('a fox', new ImageGenerationOptions());
    expect($img->revisedPrompt)->toBeNull();
});

it('maps a 400 content-policy error through verbatim as HttpError(400)', function (): void {
    $stub = stubTransport([
        'status' => 400,
        'body' => json_encode(['error' => ['message' => 'Your request was rejected as a result of our safety system']]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    expect(fn() => $gen->generate('something disallowed', new ImageGenerationOptions()))
        ->toThrow(HttpError::class, 'Your request was rejected');
});

it('maps a 401 to a generic 500 without leaking the upstream message', function (): void {
    $stub = stubTransport([
        'status' => 401,
        'body' => json_encode(['error' => ['message' => 'Invalid API key sk-xxx leaking-secret-here']]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    try {
        $gen->generate('a cat', new ImageGenerationOptions());
        expect(false)->toBeTrue('should have thrown');
    } catch (HttpError $e) {
        expect($e->statusCode)->toBe(500);
        expect($e->getMessage())->toBe('image provider authentication failed');
        expect($e->getMessage())->not->toContain('sk-xxx');
    }
});

it('maps a 429 to a 502 upstream error', function (): void {
    $stub = stubTransport([
        'status' => 429,
        'body' => json_encode(['error' => ['message' => 'Rate limit exceeded']]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    try {
        $gen->generate('a cat', new ImageGenerationOptions());
        expect(false)->toBeTrue('should have thrown');
    } catch (HttpError $e) {
        expect($e->statusCode)->toBe(502);
        expect($e->getMessage())->toContain('Rate limit exceeded');
    }
});

it('errors when the success body has no image bytes', function (): void {
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => '']]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    expect(fn() => $gen->generate('a cat', new ImageGenerationOptions()))
        ->toThrow(HttpError::class, 'no image bytes');
});

it('clamps a giant non-JSON error body so it does not flood the response', function (): void {
    $huge = str_repeat('x', 5000);
    $stub = stubTransport(['status' => 500, 'body' => $huge]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    try {
        $gen->generate('a cat', new ImageGenerationOptions());
        expect(false)->toBeTrue('should have thrown');
    } catch (HttpError $e) {
        // 200-char clamp from extractErrorMessage
        expect(strlen($e->getMessage()))->toBeLessThan(300);
    }
});
