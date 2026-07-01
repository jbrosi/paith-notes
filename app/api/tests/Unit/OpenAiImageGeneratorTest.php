<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\HttpError;
use Paith\Notes\Api\Http\Service\ImageGeneration\HttpTransport;
use Paith\Notes\Api\Http\Service\ImageGeneration\ImageGenerationOptions;
use Paith\Notes\Api\Http\Service\ImageGeneration\OpenAiImageGenerator;
use Paith\Notes\Api\Http\Service\ImageGeneration\SourceImage;

/**
 * Request shape + response parsing for the OpenAI generator, with
 * the HTTP transport stubbed so no network is required and the
 * outgoing request can be asserted on.
 */

/**
 * @param array{status: int, body: string} $canned
 * @return array{transport: HttpTransport, calls: array<int, array{url: string, headers: array<string, string>, body: string}>, multipart: array<int, array{url: string, headers: array<string, string>, parts: list<array{name: string, value: string, filename?: string, contentType?: string}>}>}
 */
function stubTransport(array $canned): array
{
    /** @var list<array{url: string, headers: array<string, string>, body: string}> $calls */
    $calls = [];
    /** @var list<array{url: string, headers: array<string, string>, parts: list<array{name: string, value: string, filename?: string, contentType?: string}>}> $multipart */
    $multipart = [];

    $transport = new class ($canned, $calls, $multipart) implements HttpTransport {
        /**
         * @param array{status: int, body: string} $canned
         * @param list<array{url: string, headers: array<string, string>, body: string}> $calls
         * @param list<array{url: string, headers: array<string, string>, parts: list<array{name: string, value: string, filename?: string, contentType?: string}>}> $multipart
         */
        public function __construct(
            private array $canned,
            public array &$calls,
            public array &$multipart,
        ) {
        }

        public function postJson(string $url, array $headers, string $jsonBody, int $timeoutSeconds): array
        {
            $this->calls[] = ['url' => $url, 'headers' => $headers, 'body' => $jsonBody];
            return $this->canned;
        }

        public function postMultipart(string $url, array $headers, array $parts, int $timeoutSeconds): array
        {
            $this->multipart[] = ['url' => $url, 'headers' => $headers, 'parts' => $parts];
            return $this->canned;
        }
    };

    return [
        'transport' => $transport,
        'calls' => &$transport->calls,
        'multipart' => &$transport->multipart,
    ];
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

it('parses usage and computes a USD estimate from gpt-image-1 token rates', function (): void {
    // text input 100 tok @ $5/M = $0.0005
    // image output 1000 tok @ $40/M = $0.04
    // total = $0.0405
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode([
            'data' => [['b64_json' => base64_encode('X')]],
            'usage' => [
                'input_tokens' => 100,
                'output_tokens' => 1000,
                'total_tokens' => 1100,
                'input_tokens_details' => ['text_tokens' => 100, 'image_tokens' => 0],
            ],
        ]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);
    $img = $gen->generate('hello', new ImageGenerationOptions());

    expect($img->usage)->not->toBeNull();
    expect($img->usage->inputTokens)->toBe(100);
    expect($img->usage->outputTokens)->toBe(1000);
    expect($img->usage->totalTokens)->toBe(1100);
    expect($img->usage->estimatedCostUsd)->toBeGreaterThan(0.040);
    expect($img->usage->estimatedCostUsd)->toBeLessThan(0.041);
});

it('returns null usage when the provider omits the usage block', function (): void {
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => base64_encode('X')]]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);
    $img = $gen->generate('hello', new ImageGenerationOptions());

    expect($img->usage)->toBeNull();
});

it('edit hits /images/edits multipart with model+prompt+size+image parts', function (): void {
    $bytes = base64_encode('PNGDATA');
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => $bytes, 'revised_prompt' => 'enhanced']]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    $img = $gen->edit(
        'enhance this drawing',
        [
            new SourceImage(bytes: 'rawpngbytes', mimeType: 'image/png', filename: 'drawing.png'),
        ],
        new ImageGenerationOptions(size: '1024x1024', transparent: false, quality: 'medium'),
    );

    // JSON path not used
    expect($stub['calls'])->toBe([]);
    expect($stub['multipart'])->toHaveCount(1);
    $call = $stub['multipart'][0];
    expect($call['url'])->toBe('https://api.openai.com/v1/images/edits');
    expect($call['headers']['Authorization'])->toBe('Bearer sk-test');

    // Index parts by name so the assertion order doesn't have to track
    // the impl ordering (which is implementation detail).
    $byName = [];
    foreach ($call['parts'] as $p) {
        $byName[$p['name']][] = $p;
    }
    expect($byName['model'][0]['value'])->toBe('gpt-image-1');
    expect($byName['prompt'][0]['value'])->toBe('enhance this drawing');
    expect($byName['size'][0]['value'])->toBe('1024x1024');
    expect($byName['quality'][0]['value'])->toBe('medium');
    expect($byName['background'][0]['value'])->toBe('opaque');
    expect($byName['image[]'])->toHaveCount(1);
    expect($byName['image[]'][0]['value'])->toBe('rawpngbytes');
    expect($byName['image[]'][0]['filename'])->toBe('drawing.png');
    expect($byName['image[]'][0]['contentType'])->toBe('image/png');

    expect($img->bytes)->toBe('PNGDATA');
    expect($img->revisedPrompt)->toBe('enhanced');
});

it('edit sends one image[] part per source', function (): void {
    $stub = stubTransport([
        'status' => 200,
        'body' => json_encode(['data' => [['b64_json' => base64_encode('X')]]]),
    ]);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    $gen->edit(
        'combine these',
        [
            new SourceImage(bytes: 'A', mimeType: 'image/png', filename: 'a.png'),
            new SourceImage(bytes: 'B', mimeType: 'image/webp', filename: 'b.webp'),
        ],
        new ImageGenerationOptions(),
    );

    $imageParts = array_values(array_filter($stub['multipart'][0]['parts'], fn($p) => $p['name'] === 'image[]'));
    expect($imageParts)->toHaveCount(2);
    expect($imageParts[0]['value'])->toBe('A');
    expect($imageParts[1]['value'])->toBe('B');
    expect($imageParts[1]['contentType'])->toBe('image/webp');
});

it('edit requires at least one source image', function (): void {
    $stub = stubTransport(['status' => 200, 'body' => '{}']);
    $gen = new OpenAiImageGenerator('sk-test', 'gpt-image-1', $stub['transport']);

    expect(fn() => $gen->edit('x', [], new ImageGenerationOptions()))
        ->toThrow(HttpError::class, 'at least one source image');
    expect($stub['multipart'])->toBe([]);
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
