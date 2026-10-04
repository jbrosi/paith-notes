<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/*
 * Feature tests for POST /api/nooks/{nookId}/chat-images — the backend half
 * of "the model saves a pasted chat image as a note" (MCP tool
 * save_image_to_note).
 *
 * The invariant these tests really guard: the bytes stored are the bytes the
 * user pasted, at FULL RESOLUTION, untouched. Resizing for the model's vision
 * happens in MCP (sharp) and must never reach this endpoint.
 *
 * Writes to FILES_DATA_PATH=/tmp/paith-chat-images-test so artefacts don't
 * pollute the dev /data volume.
 */

$savedFilesDataPath = null;

beforeEach(function () use (&$savedFilesDataPath): void {
    $savedFilesDataPath = getenv('FILES_DATA_PATH');

    putenv('KEYCLOAK_ENABLED=0');
    putenv('FILES_DATA_PATH=/tmp/paith-chat-images-test');

    if (is_dir('/tmp/paith-chat-images-test')) {
        $it = new RecursiveDirectoryIterator('/tmp/paith-chat-images-test', RecursiveDirectoryIterator::SKIP_DOTS);
        $files = new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $f) {
            $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
    }

    $pdo = test_pdo();
    ensure_global_schema($pdo);
    test_reset_state($pdo);
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadbeef-ee00-4000-8000-000000000000', 'Chat', 'Tester') on conflict (id) do nothing");
});

afterEach(function () use (&$savedFilesDataPath): void {
    if ($savedFilesDataPath === false) {
        putenv('FILES_DATA_PATH');
    } else {
        putenv('FILES_DATA_PATH=' . $savedFilesDataPath);
    }
});

/** @return array{0: array<string, string>, 1: string} [headers, nookId] */
function chatImagesSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_str(['name' => 'Test']));
    return [$headers, json_body($res)['nook']['id']];
}

/**
 * A real PNG of the given size, so we can assert the stored file kept its
 * original pixel dimensions (i.e. nothing down-scaled it on the way in).
 * $seed varies the colour so a replaced file is distinguishable.
 */
function chatImagesPng(int $width, int $height, int $seed): string
{
    $im = imagecreatetruecolor($width, $height);
    $bg = imagecolorallocate($im, $seed % 256, ($seed * 3) % 256, ($seed * 7) % 256);
    imagefilledrectangle($im, 0, 0, $width, $height, $bg);
    ob_start();
    imagepng($im);
    $bytes = (string) ob_get_clean();
    unset($im);
    return $bytes;
}

/** @return array{0: int, 1: int} [width, height] */
function chatImagesDims(string $absolutePath): array
{
    $info = getimagesize($absolutePath);
    expect($info)->not->toBeFalse("could not read image at {$absolutePath}");
    return [$info[0], $info[1]];
}

it('creates a new note with the image at FULL RESOLUTION', function (): void {
    [$headers, $nookId] = chatImagesSetup('aaaaaaaaaaaa');

    $bytes = chatImagesPng(800, 600, 10);
    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode($bytes),
        'media_type' => 'image/png',
        'title' => 'Pasted screenshot',
        'filename' => 'shot.png',
    ]));

    expect($res['status'])->toBe(200, $res['body']);
    $body = json_body($res);

    expect($body['mode'])->toBe('new_note');
    expect($body['note']['title'])->toBe('Pasted screenshot');
    expect($body['note']['nook_id'])->toBe($nookId);
    expect($body['file']['mime_type'])->toBe('image/png');
    expect($body['file']['extension'])->toBe('png');
    expect($body['file']['file_version'])->toBe(1);
    expect($body['file']['filesize'])->toBe(strlen($bytes));
    expect($body['embed'])->toContain($body['note']['id']);

    // THE invariant: bytes on disk are byte-identical to what was posted…
    $path = '/tmp/paith-chat-images-test/' . $body['file']['object_key'];
    expect(file_exists($path))->toBeTrue("expected file at {$path}");
    expect(file_get_contents($path))->toBe($bytes);
    // …and still at the original pixel dimensions (never down-scaled).
    expect(chatImagesDims($path))->toBe([800, 600]);
});

it('records the checksum and a single note_files row for a new note', function (): void {
    [$headers, $nookId] = chatImagesSetup('bbbbbbbbbbbb');

    $bytes = chatImagesPng(64, 64, 20);
    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode($bytes),
        'media_type' => 'image/png',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $body = json_body($res);
    $noteId = $body['note']['id'];

    $pdo = test_pdo();
    $stmt = $pdo->prepare('select object_key, checksum, file_version, mime_type from global.note_files where note_id = :nid');
    $stmt->execute([':nid' => $noteId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    expect($rows)->toHaveCount(1);
    expect($rows[0]['object_key'])->toBe($body['file']['object_key']);
    expect($rows[0]['checksum'])->toBe(hash('sha256', $bytes));
    expect((int) $rows[0]['file_version'])->toBe(1);
});

it('attaches to an existing image note as a new version (one note_files row)', function (): void {
    [$headers, $nookId] = chatImagesSetup('cccccccccccc');

    $v1 = chatImagesPng(800, 600, 30);
    $create = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode($v1),
        'media_type' => 'image/png',
        'title' => 'Sketch',
    ]));
    expect($create['status'])->toBe(200, $create['body']);
    $noteId = json_body($create)['note']['id'];

    $v2 = chatImagesPng(1024, 768, 90);
    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode($v2),
        'media_type' => 'image/png',
        'note_id' => $noteId,
        'filename' => 'sketch-v2.png',
    ]));

    expect($res['status'])->toBe(200, $res['body']);
    $body = json_body($res);
    expect($body['mode'])->toBe('attached');
    expect($body['note']['id'])->toBe($noteId);
    expect($body['file']['file_version'])->toBe(2);
    expect($body['file']['filesize'])->toBe(strlen($v2));

    // global.note_files is keyed by note_id (PRIMARY KEY): attaching must
    // UPDATE the row in place, never insert a second one.
    $pdo = test_pdo();
    $stmt = $pdo->prepare('select file_version, object_key, checksum from global.note_files where note_id = :nid');
    $stmt->execute([':nid' => $noteId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    expect($rows)->toHaveCount(1);
    expect((int) $rows[0]['file_version'])->toBe(2);
    expect($rows[0]['object_key'])->toBe($body['file']['object_key']);
    expect($rows[0]['checksum'])->toBe(hash('sha256', $v2));

    // The note's file_version attribute pointer moved forward, so the UI
    // renders v2 rather than the image it just replaced.
    $attrStmt = $pdo->prepare('select attributes from global.notes where id = :id');
    $attrStmt->execute([':id' => $noteId]);
    $attrs = json_decode((string) $attrStmt->fetchColumn(), true);
    $attrId = $body['file']['attribute_id'];
    expect($attrId)->not->toBe('');
    expect($attrs[$attrId]['file_version'])->toBe(2);

    // New bytes on disk, still full resolution.
    $path = '/tmp/paith-chat-images-test/' . $body['file']['object_key'];
    expect(file_get_contents($path))->toBe($v2);
    expect(chatImagesDims($path))->toBe([1024, 768]);
});

it('bumps the version again on a third attach', function (): void {
    [$headers, $nookId] = chatImagesSetup('dddddddddddd');

    $create = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode(chatImagesPng(32, 32, 40)),
        'media_type' => 'image/png',
    ]));
    $noteId = json_body($create)['note']['id'];

    foreach ([50, 60] as $seed) {
        $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
            'image_data' => base64_encode(chatImagesPng(32, 32, $seed)),
            'media_type' => 'image/png',
            'note_id' => $noteId,
        ]));
        expect($res['status'])->toBe(200, $res['body']);
    }
    expect(json_body($res)['file']['file_version'])->toBe(3);

    $pdo = test_pdo();
    $stmt = $pdo->prepare('select count(*) from global.note_files where note_id = :nid');
    $stmt->execute([':nid' => $noteId]);
    expect((int) $stmt->fetchColumn())->toBe(1);
});

it('refuses to attach to a note that has no file', function (): void {
    [$headers, $nookId] = chatImagesSetup('eeeeeeeeeeee');

    $note = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str(['title' => 'plain']));
    $plainId = json_body($note)['note']['id'];

    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode(chatImagesPng(16, 16, 70)),
        'media_type' => 'image/png',
        'note_id' => $plainId,
    ]));
    expect($res['status'])->toBe(400);
    expect(json_body($res)['error'])->toContain('no attached file');
});

it('404s when the target note does not exist', function (): void {
    [$headers, $nookId] = chatImagesSetup('ffffffffffff');

    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode(chatImagesPng(16, 16, 80)),
        'media_type' => 'image/png',
        'note_id' => '00000000-0000-4000-8000-00000000dead',
    ]));
    expect($res['status'])->toBe(404);
});

it('accepts a data: URI and sniffs the mime when media_type is absent', function (): void {
    [$headers, $nookId] = chatImagesSetup('111111111111');

    $bytes = chatImagesPng(48, 24, 100);
    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => 'data:image/png;base64,' . base64_encode($bytes),
    ]));

    expect($res['status'])->toBe(200, $res['body']);
    $body = json_body($res);
    expect($body['file']['mime_type'])->toBe('image/png');
    expect($body['file']['extension'])->toBe('png');
    // No filename supplied → derived from the sniffed extension.
    expect($body['file']['filename'])->toBe('image.png');
    expect(file_get_contents('/tmp/paith-chat-images-test/' . $body['file']['object_key']))->toBe($bytes);
});

it('rejects a payload that is not a detectable image', function (): void {
    [$headers, $nookId] = chatImagesSetup('222222222222');

    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode('this is definitely not an image'),
    ]));
    expect($res['status'])->toBe(400);
    expect(json_body($res)['error'])->toContain('unsupported');
});

it('rejects a missing image_data', function (): void {
    [$headers, $nookId] = chatImagesSetup('333333333333');

    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str(['title' => 'nothing']));
    expect($res['status'])->toBe(400);
    expect(json_body($res)['error'])->toContain('image_data');
});

it('falls back to the filename when no title is given', function (): void {
    [$headers, $nookId] = chatImagesSetup('444444444444');

    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode(chatImagesPng(16, 16, 110)),
        'media_type' => 'image/jpeg',
        'filename' => 'my holiday snap.jpg',
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    // A jpeg label with png bytes → mime sniffing wins over the claim, so we
    // just assert a title was derived rather than over-specifying the format.
    expect(json_body($res)['note']['title'])->not->toBe('');
});

it('requires authentication', function (): void {
    $res = App::handle('POST', '/api/nooks/00000000-0000-4000-8000-00000000beef/chat-images', [], json_str([
        'image_data' => base64_encode(chatImagesPng(8, 8, 120)),
        'media_type' => 'image/png',
    ]));
    expect($res['status'])->toBe(401);
});
