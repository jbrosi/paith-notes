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

it('uses the generated_image type and populates typed attributes in ai-memory', function (): void {
    $pdo = test_pdo();
    [$headers] = aiImagesSetup('000000000003');

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'a serene mountain at dawn',
        'size' => '1024x1536',
        'quality' => 'medium',
        'summary' => 'First take of the dawn mountain scene for the calendar cover.',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);

    // Type should be generated_image, not plain `file`
    $typeRow = $pdo->query("select key from global.note_types where id = " . $pdo->quote($body['note']['type_id']))->fetch(PDO::FETCH_ASSOC);
    expect($typeRow['key'])->toBe('generated_image');

    // All 10 telemetry attributes should be present on the type
    $expectedKeys = ['prompt', 'revised_prompt', 'size', 'quality', 'transparent', 'model', 'cost_usd', 'input_tokens', 'output_tokens', 'duration_ms'];
    $attrRows = $pdo->query(
        "select key from global.type_attributes where type_id = " . $pdo->quote($body['note']['type_id']) . " order by key"
    )->fetchAll(PDO::FETCH_COLUMN);
    foreach ($expectedKeys as $k) {
        expect($attrRows)->toContain($k);
    }

    // Inspect the stored note row to verify attribute values landed
    $note = $pdo->query("select content, attributes from global.notes where id = " . $pdo->quote($body['note']['id']))->fetch(PDO::FETCH_ASSOC);
    $attrs = json_decode($note['attributes'], true);

    // Key the response by attribute key for assertions
    $byKey = [];
    foreach ($pdo->query("select key, id from global.type_attributes where type_id = " . $pdo->quote($body['note']['type_id']))->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $byKey[$r['key']] = $r['id'];
    }

    expect($attrs[$byKey['prompt']])->toBe('a serene mountain at dawn');
    expect($attrs[$byKey['size']])->toBe(['width' => 1024, 'height' => 1536]);
    expect($attrs[$byKey['quality']])->toBe('medium');
    expect($attrs[$byKey['model']])->toBe('fake/static-png');
    // duration_ms is wall-clock and >= 0 (could be 0 if very fast)
    expect($attrs[$byKey['duration_ms']])->toBeGreaterThanOrEqual(0);

    // Content body should carry the v1 summary header
    expect($note['content'])->toContain('## v1');
    expect($note['content'])->toContain('dawn mountain scene');
});

it('falls back to the plain file type for non ai-memory nooks', function (): void {
    $pdo = test_pdo();
    [$headers, $nookId] = aiImagesSetup('000000000004');

    $res = App::handle('POST', "/api/nooks/{$nookId}/ai-images", $headers, json_encode([
        'prompt' => 'a fox',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_decode($res['body'], true);

    $typeRow = $pdo->query("select key from global.note_types where id = " . $pdo->quote($body['note']['type_id']))->fetch(PDO::FETCH_ASSOC);
    expect($typeRow['key'])->toBe('file');

    // No generated_image type should have been seeded in this nook
    $count = $pdo->query("select count(*)::int from global.note_types where nook_id = " . $pdo->quote($nookId) . " and key = 'generated_image'")->fetchColumn();
    expect((int)$count)->toBe(0);
});

it('refines an existing generated_image: same note id, bumped file_version, appended summary', function (): void {
    $pdo = test_pdo();
    [$headers] = aiImagesSetup('000000000005');

    // Initial generation
    $first = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'a serene mountain at dawn',
        'size' => '1024x1536',
        'quality' => 'medium',
        'summary' => 'First take of the dawn scene.',
    ]));
    expect($first['status'])->toBe(200, $first['body']);
    $firstBody = json_decode($first['body'], true);
    $noteId = $firstBody['note']['id'];

    // Refinement — only prompt + summary change. Size/quality are omitted
    // so should inherit '1024x1536' / 'medium'.
    $second = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'same scene but with golden hour light and more clouds',
        'refine_note_id' => $noteId,
        'summary' => 'Switched to golden hour per user request.',
    ]));
    expect($second['status'])->toBe(200, $second['body']);
    $secondBody = json_decode($second['body'], true);

    // Same note id, refined flag set, file_version bumped
    expect($secondBody['note']['id'])->toBe($noteId);
    expect($secondBody['note']['refined'])->toBeTrue();
    expect($secondBody['file']['file_version'])->toBe(2);

    // Content body should hold both v1 and v2 sections
    $note = $pdo->query("select content from global.notes where id = " . $pdo->quote($noteId))->fetch(PDO::FETCH_ASSOC);
    expect($note['content'])->toContain('## v1');
    expect($note['content'])->toContain('First take');
    expect($note['content'])->toContain('## v2');
    expect($note['content'])->toContain('golden hour');

    // Attributes by key — size inherited, quality inherited, prompt updated
    $byKey = [];
    foreach ($pdo->query("select key, id from global.type_attributes where type_id = " . $pdo->quote($firstBody['note']['type_id']))->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $byKey[$r['key']] = $r['id'];
    }
    $attrs = json_decode($pdo->query("select attributes from global.notes where id = " . $pdo->quote($noteId))->fetchColumn(), true);
    expect($attrs[$byKey['size']])->toBe(['width' => 1024, 'height' => 1536]);
    expect($attrs[$byKey['quality']])->toBe('medium');
    expect($attrs[$byKey['prompt']])->toBe('same scene but with golden hour light and more clouds');

    // note_files row updated in place, pointing at the v2 object key
    $fileRow = $pdo->query("select object_key, file_version from global.note_files where note_id = " . $pdo->quote($noteId))->fetch(PDO::FETCH_ASSOC);
    expect((int)$fileRow['file_version'])->toBe(2);
    expect($fileRow['object_key'])->toEndWith('/v2');
});

it('refining lets the AI override individual inherited fields (quality bump)', function (): void {
    $pdo = test_pdo();
    [$headers] = aiImagesSetup('000000000006');

    $first = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'a fox',
        'quality' => 'low',
        'summary' => 'Quick sketch of a fox.',
    ]));
    $noteId = json_decode($first['body'], true)['note']['id'];

    $second = App::handle('POST', '/api/nooks/ai-memory/ai-images', $headers, json_encode([
        'prompt' => 'the same fox but as a finished printable poster',
        'refine_note_id' => $noteId,
        'quality' => 'high',
        'summary' => 'Final poster-quality version.',
    ]));
    expect($second['status'])->toBe(200, $second['body']);

    $typeId = json_decode($first['body'], true)['note']['type_id'];
    $byKey = [];
    foreach ($pdo->query("select key, id from global.type_attributes where type_id = " . $pdo->quote($typeId))->fetchAll(PDO::FETCH_ASSOC) as $r) {
        $byKey[$r['key']] = $r['id'];
    }
    $attrs = json_decode($pdo->query("select attributes from global.notes where id = " . $pdo->quote($noteId))->fetchColumn(), true);
    expect($attrs[$byKey['quality']])->toBe('high');
});

it('rejects a refine_note_id that targets a note in a different nook', function (): void {
    [$ownerHeaders, $ownerNookId] = aiImagesSetup('000000000007');
    // Create a note in the owner's nook
    $note = App::handle('POST', "/api/nooks/{$ownerNookId}/notes", $ownerHeaders, json_encode(['title' => 'unrelated']));
    $ownerNoteId = json_decode($note['body'], true)['note']['id'];

    $res = App::handle('POST', '/api/nooks/ai-memory/ai-images', $ownerHeaders, json_encode([
        'prompt' => 'should fail — note is in another nook',
        'refine_note_id' => $ownerNoteId,
        'summary' => 'x',
    ]));
    expect($res['status'])->toBe(404);
});

it('rejects refining a note that is not a generated_image', function (): void {
    [$headers, $nookId] = aiImagesSetup('000000000008');
    // Create a plain note in ai-memory by hand-crafting the row (not via
    // generate_image), so its type is whatever the default is, not
    // generated_image.
    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'plain']));
    $plainNoteId = json_decode($note['body'], true)['note']['id'];

    $res = App::handle('POST', "/api/nooks/{$nookId}/ai-images", $headers, json_encode([
        'prompt' => 'should fail',
        'refine_note_id' => $plainNoteId,
        'summary' => 'x',
    ]));
    expect($res['status'])->toBe(400);
    expect(json_decode($res['body'], true)['error'])->toContain('generated_image');
});
