<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;
use Paith\Notes\Api\Http\Controller\AiImagesController;
use Paith\Notes\Api\Http\Service\ImageGeneration\FakeImageGenerator;

/**
 * Feature tests for POST /api/nooks/{nookId}/ai-images.
 *
 * Uses IMAGE_PROVIDER=fake so no network/spend; FakeImageGenerator
 * returns a fixed 1x1 PNG and echoes the prompt back as
 * revised_prompt so we can assert the full request/response loop.
 *
 * Writes to FILES_DATA_PATH=/tmp/paith-ai-images-test so artefacts
 * don't pollute the dev /data volume; the dir is wiped per test.
 */

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    putenv('IMAGE_PROVIDER=fake');
    putenv('FILES_DATA_PATH=/tmp/paith-ai-images-test');
    AiImagesController::$generatorOverride = null;

    if (is_dir('/tmp/paith-ai-images-test')) {
        // Best-effort recursive cleanup so leftover bytes from prior
        // test runs don't make filesize / checksum assertions flaky.
        $it = new RecursiveDirectoryIterator('/tmp/paith-ai-images-test', RecursiveDirectoryIterator::SKIP_DOTS);
        $files = new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $f) {
            $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
    }

    $pdo = test_pdo();
    ensure_global_schema($pdo);
    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

afterEach(function (): void {
    putenv('IMAGE_PROVIDER');
    putenv('FILES_DATA_PATH');
    AiImagesController::$generatorOverride = null;
});

/** @return array{0: array<string, string>, 1: string} [headers, nookId] */
function aiImagesSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    // /api/me triggers the ai-memory nook bootstrap in RequireUser middleware
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Test']));
    return [$headers, json_decode($res['body'], true)['nook']['id']];
}

it('creates a note + on-disk file from a prompt against ai-memory', function (): void {
    [$headers] = aiImagesSetup('aaaaaaaaaaaa');

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'a serene mountain at dawn',
    ]));

    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);

    expect($body['note']['title'])->toBe('a serene mountain at dawn');
    expect($body['note']['type_id'])->not->toBe('');
    expect($body['file']['mime_type'])->toBe('image/png');
    expect($body['file']['extension'])->toBe('png');
    expect($body['file']['filesize'])->toBeGreaterThan(0);
    expect($body['revised_prompt'])->toBe('a serene mountain at dawn');
    expect($body['provider_model'])->toBe('fake/static-png');

    // The bytes actually landed on disk under FILES_DATA_PATH
    $path = '/tmp/paith-ai-images-test/' . $body['file']['object_key'];
    expect(file_exists($path))->toBeTrue("expected file at {$path}");
    expect(filesize($path))->toBe($body['file']['filesize']);
});

it('lands the note in the resolved ai-memory nook, not the test nook', function (): void {
    $pdo = test_pdo();
    [$headers, $testNookId] = aiImagesSetup('bbbbbbbbbbbb');

    // Look up the user's ai-memory nook id
    $userId = $headers['X-Nook-User'];
    $aiMemId = $pdo->query(
        "select n.id from global.nooks n join global.nook_members nm on nm.nook_id = n.id "
        . "where nm.user_id = " . $pdo->quote($userId) . " and n.purpose = 'ai-memory' limit 1"
    )->fetchColumn();
    expect($aiMemId)->toBeString()->not->toBe($testNookId);

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'a fox',
    ]));
    expect($res['status'])->toBe(200);

    $body = json_decode($res['body'], true);
    expect($body['note']['nook_id'])->toBe($aiMemId);
});

it('also works with an explicit nook UUID', function (): void {
    [$headers, $nookId] = aiImagesSetup('cccccccccccc');

    $res = App::handle('POST', "/api/nooks/{$nookId}/ai-images", $headers, json_encode([
        'prompt' => 'a watercolor sunset',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    expect(json_decode($res['body'], true)['note']['nook_id'])->toBe($nookId);
});

it('truncates long prompts when building the note title', function (): void {
    [$headers] = aiImagesSetup('dddddddddddd');

    $longPrompt = str_repeat('a beautiful sunset over the ocean ', 8); // > 80 chars
    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => $longPrompt,
    ]));
    expect($res['status'])->toBe(200);

    $title = json_decode($res['body'], true)['note']['title'];
    expect(mb_strlen($title))->toBeLessThanOrEqual(80);
    expect(str_ends_with($title, '…'))->toBeTrue();
});

it('rejects a missing prompt with 400', function (): void {
    [$headers] = aiImagesSetup('eeeeeeeeeeee');

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('prompt');
});

it('rejects an unsupported size whitelist value', function (): void {
    [$headers] = aiImagesSetup('ffffffffffff');

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'x',
        'size' => '999x999',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('size');
});

it('rejects an unsupported quality value', function (): void {
    [$headers] = aiImagesSetup('111111111111');

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'x',
        'quality' => 'ultra',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('quality');
});

it('returns 403 when targeting a nook the caller does not belong to', function (): void {
    [, $ownerNookId] = aiImagesSetup('000000000001');

    $strangerHeaders = ['X-Nook-User' => 'eeeeeeee-eeee-4eee-8eee-fffffffffffe', 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $strangerHeaders, '');

    $res = App::handle('POST', "/api/nooks/{$ownerNookId}/ai-images", $strangerHeaders, json_encode([
        'prompt' => 'should not work',
    ]));
    expect($res['status'])->toBe(403);
});

it('bubbles provider-rejected prompts as 400 so the AI sees the failure cleanly', function (): void {
    [$headers] = aiImagesSetup('000000000002');

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'please REJECT this one',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('fake-rejected');
});
