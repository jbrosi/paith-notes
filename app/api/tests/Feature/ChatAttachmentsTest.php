<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

/*
 * Feature tests for the durable chat-attachment store and the note-image read
 * endpoint — the backend half of "analyse an image now, keep it, look at it
 * again later".
 *
 * The invariants that matter:
 *   1. The ORIGINAL full-resolution bytes survive the round trip. The ≤1024px
 *      vision copy in the conversation block is all the model was shown; the
 *      attachment must never be that copy.
 *   2. `attachment_index` is append-only for the life of the conversation, so
 *      `[IMAGE n]` always names the same picture even after later turns.
 *   3. A note copy is a byte-identical copy of the attachment, not a re-encode.
 *   4. Deleting the conversation removes BOTH the rows and the bytes — a DB
 *      cascade cannot reach the filesystem, so that part is explicit.
 *   5. Nothing here is reachable by another user's conversation.
 *
 * Writes to FILES_DATA_PATH=/tmp/paith-chat-attachments-test.
 */

const CHAT_ATTACHMENTS_ROOT = '/tmp/paith-chat-attachments-test';

$savedFilesDataPath = null;

beforeEach(function () use (&$savedFilesDataPath): void {
    $savedFilesDataPath = getenv('FILES_DATA_PATH');

    putenv('KEYCLOAK_ENABLED=0');
    putenv('FILES_DATA_PATH=' . CHAT_ATTACHMENTS_ROOT);

    if (is_dir(CHAT_ATTACHMENTS_ROOT)) {
        $it = new RecursiveDirectoryIterator(CHAT_ATTACHMENTS_ROOT, RecursiveDirectoryIterator::SKIP_DOTS);
        $files = new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($files as $f) {
            $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        }
    }

    $pdo = test_pdo();
    ensure_global_schema($pdo);
    test_reset_state($pdo, 'global.conversations');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadbeef-ee00-4000-8000-000000000000', 'Attach', 'Tester') on conflict (id) do nothing");
});

afterEach(function () use (&$savedFilesDataPath): void {
    if ($savedFilesDataPath === false) {
        putenv('FILES_DATA_PATH');
    } else {
        putenv('FILES_DATA_PATH=' . $savedFilesDataPath);
    }
});

/** @return array{0: array<string, string>, 1: string} [headers, nookId] */
function chatAttachSetup(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    $res = App::handle('POST', '/api/nooks', $headers, json_str(['name' => 'Attach Test']));
    return [$headers, (string) json_body($res)['nook']['id']];
}

function chatAttachConversation(array $headers, string $title = 'Chat'): string
{
    $res = App::handle('POST', '/api/conversations', $headers, json_str(['title' => $title, 'model' => 'paith-high']));
    expect($res['status'])->toBe(200);
    return (string) json_body($res)['conversation']['id'];
}

/** Real PNG bytes so pixel dimensions prove nothing was down-scaled. */
function chatAttachPng(int $width, int $height, int $seed): string
{
    $im = imagecreatetruecolor($width, $height);
    imagefilledrectangle($im, 0, 0, $width, $height, imagecolorallocate($im, $seed % 256, ($seed * 3) % 256, ($seed * 7) % 256));
    ob_start();
    imagepng($im);
    $bytes = (string) ob_get_clean();
    unset($im);
    return $bytes;
}

/** @param list<string> $pngs */
function chatAttachStore(array $headers, string $conversationId, array $pngs, ?string $nookId = null, ?string $turnId = null): array
{
    $images = [];
    foreach ($pngs as $i => $png) {
        $images[] = ['data' => base64_encode($png), 'media_type' => 'image/png', 'filename' => "shot-{$i}.png"];
    }
    $res = App::handle('POST', "/api/conversations/{$conversationId}/images", $headers, json_str([
        'images' => $images,
        ...($nookId ? ['nook_id' => $nookId] : []),
        ...($turnId ? ['turn_id' => $turnId] : []),
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    return json_body($res)['images'];
}

/** @return array{0: int, 1: int} [width, height] */
function chatAttachDims(string $absolutePath): array
{
    $info = getimagesize($absolutePath);
    expect($info)->not->toBeFalse("could not read image at {$absolutePath}");
    return [$info[0], $info[1]];
}

it('stores the pasted originals at FULL RESOLUTION and returns durable ids', function (): void {
    [$headers] = chatAttachSetup('aaaaaaaaaaaa');
    $convId = chatAttachConversation($headers);
    $png = chatAttachPng(1600, 900, 10);

    $rows = chatAttachStore($headers, $convId, [$png]);

    expect($rows)->toHaveCount(1);
    expect($rows[0]['id'])->toMatch('/^[0-9a-f-]{36}$/');
    expect($rows[0]['attachment_index'])->toBe(1);
    expect($rows[0]['filename'])->toBe('shot-0.png');
    expect($rows[0]['media_type'])->toBe('image/png');
    expect($rows[0]['filesize'])->toBe(strlen($png));
    expect($rows[0]['checksum'])->toBe(hash('sha256', $png));

    // Bytes on disk are the user's bytes, still full size.
    $stmt = test_pdo()->prepare('select object_key from global.conversation_images where id = :id');
    $stmt->execute([':id' => $rows[0]['id']]);
    $key = (string) $stmt->fetchColumn();
    expect($key)->toStartWith("chat/{$convId}/images/");
    $path = CHAT_ATTACHMENTS_ROOT . '/' . $key;
    expect(file_get_contents($path))->toBe($png);
    expect(chatAttachDims($path))->toBe([1600, 900]);
});

it('accepts a data: URI and sniffs the mime instead of trusting the label', function (): void {
    [$headers] = chatAttachSetup('bbbbbbbbbbbb');
    $convId = chatAttachConversation($headers);

    $res = App::handle('POST', "/api/conversations/{$convId}/images", $headers, json_str([
        'images' => [['data' => 'data:image/png;base64,' . base64_encode(chatAttachPng(8, 8, 20))]],
    ]));
    expect($res['status'])->toBe(200, $res['body']);
    $row = json_body($res)['images'][0];
    expect($row['media_type'])->toBe('image/png');
    // No filename supplied → derived from the sniffed extension.
    expect($row['filename'])->toBe('image.png');
});

it('keeps attachment_index append-only across turns so [IMAGE n] never shifts', function (): void {
    [$headers] = chatAttachSetup('cccccccccccc');
    $convId = chatAttachConversation($headers);

    $turn1 = chatAttachStore($headers, $convId, [chatAttachPng(8, 8, 30), chatAttachPng(8, 8, 31)]);
    expect(array_column($turn1, 'attachment_index'))->toBe([1, 2]);

    // A later turn continues the numbering rather than restarting at 1 —
    // a reused [IMAGE 1] would point at a different picture than the transcript says.
    $turn2 = chatAttachStore($headers, $convId, [chatAttachPng(8, 8, 32)]);
    expect($turn2[0]['attachment_index'])->toBe(3);

    $list = json_body(App::handle('GET', "/api/conversations/{$convId}/images", $headers, ''));
    expect(array_column($list['images'], 'attachment_index'))->toBe([1, 2, 3]);
    expect($list['images'][2]['id'])->toBe($turn2[0]['id']);
});

it('reads an attachment back as the original bytes', function (): void {
    [$headers] = chatAttachSetup('dddddddddddd');
    $convId = chatAttachConversation($headers);
    $png = chatAttachPng(640, 480, 40);
    $row = chatAttachStore($headers, $convId, [$png])[0];

    $res = App::handle('GET', "/api/conversations/{$convId}/images/{$row['id']}", $headers, '');

    expect($res['status'])->toBe(200);
    expect($res['body'])->toBe($png, 'look_at_image must get the full-resolution original back');
    expect($res['headers']['Content-Type'] ?? '')->toContain('image/png');
    expect($res['headers']['X-Image-Filename'] ?? '')->toBe('shot-0.png');
});

it('will not serve an attachment through the wrong conversation or to another user', function (): void {
    [$ownerHeaders] = chatAttachSetup('eeeeeeeeeeee');
    $convId = chatAttachConversation($ownerHeaders);
    $row = chatAttachStore($ownerHeaders, $convId, [chatAttachPng(8, 8, 50)])[0];

    // A second conversation of the same user: the id is valid, the route is not.
    $otherConv = chatAttachConversation($ownerHeaders, 'Other');
    expect(App::handle('GET', "/api/conversations/{$otherConv}/images/{$row['id']}", $ownerHeaders, '')['status'])->toBe(404);

    // Another user's conversation id: not even a leak of existence.
    [$strangerHeaders] = chatAttachSetup('ffffffffffff');
    $strangerConv = chatAttachConversation($strangerHeaders);
    expect(App::handle('GET', "/api/conversations/{$strangerConv}/images/{$row['id']}", $strangerHeaders, '')['status'])->toBe(404);

    // Listing is scoped to the caller's own conversation too: the stranger can
    // list their own (empty) conversation, but it must not contain the owner's
    // attachment, and the owner's conversation must not be listable at all.
    $ownList = App::handle('GET', "/api/conversations/{$strangerConv}/images", $strangerHeaders, '');
    expect($ownList['status'])->toBe(200, 'listing your own conversation is legal, just empty here');
    expect(json_body($ownList)['images'])->toBe([]);
    expect(App::handle('GET', "/api/conversations/{$convId}/images", $strangerHeaders, '')['status'])
        ->toBe(404, 'the owner\'s conversation must not be listable by a stranger');

    // …and the owner still sees exactly their own row.
    $ownerList = App::handle('GET', "/api/conversations/{$convId}/images", $ownerHeaders, '');
    expect($ownerList['status'])->toBe(200);
    expect(array_column(json_body($ownerList)['images'], 'id'))->toBe([$row['id']]);
});

it('404s for an unknown conversation rather than creating one implicitly', function (): void {
    [$headers] = chatAttachSetup('111111111111');
    $res = App::handle('POST', '/api/conversations/00000000-0000-4000-8000-00000000dead/images', $headers, json_str([
        'images' => [['data' => base64_encode(chatAttachPng(8, 8, 60)), 'media_type' => 'image/png']],
    ]));
    expect($res['status'])->toBe(404);
});

it('requires authentication', function (): void {
    $res = App::handle('POST', '/api/conversations/00000000-0000-4000-8000-00000000beef/images', [], json_str([
        'images' => [['data' => base64_encode(chatAttachPng(8, 8, 70))]],
    ]));
    expect($res['status'])->toBe(401);
});

it('rejects junk, an empty batch, and an oversized batch', function (): void {
    [$headers] = chatAttachSetup('222222222222');
    $convId = chatAttachConversation($headers);

    $junk = App::handle('POST', "/api/conversations/{$convId}/images", $headers, json_str([
        'images' => [['data' => base64_encode('definitely not an image')]],
    ]));
    expect($junk['status'])->toBe(400);
    expect(json_body($junk)['error'])->toContain('unsupported');

    expect(App::handle('POST', "/api/conversations/{$convId}/images", $headers, json_str(['images' => []]))['status'])->toBe(400);

    $many = [];
    for ($i = 0; $i < 5; $i++) {
        $many[] = ['data' => base64_encode(chatAttachPng(8, 8, 80 + $i))];
    }
    expect(App::handle('POST', "/api/conversations/{$convId}/images", $headers, json_str(['images' => $many]))['status'])->toBe(400);

    // A rejected batch must leave nothing behind — no rows, no orphaned bytes.
    $stmt = test_pdo()->prepare('select count(*) from global.conversation_images where conversation_id = :c');
    $stmt->execute([':c' => $convId]);
    expect((int) $stmt->fetchColumn())->toBe(0);
    expect(is_dir(CHAT_ATTACHMENTS_ROOT . "/chat/{$convId}"))->toBeFalse();
});

it('cleans up the bytes written by a batch that failed halfway', function (): void {
    [$headers] = chatAttachSetup('333333333333');
    $convId = chatAttachConversation($headers);

    $res = App::handle('POST', "/api/conversations/{$convId}/images", $headers, json_str([
        'images' => [
            ['data' => base64_encode(chatAttachPng(8, 8, 90)), 'media_type' => 'image/png'],
            ['data' => base64_encode('not an image at all'), 'media_type' => 'image/png'],
        ],
    ]));
    expect($res['status'])->toBe(400);

    // The first image was already written to disk before the second blew up;
    // it must not be left orphaned with no row pointing at it.
    $stmt = test_pdo()->prepare('select count(*) from global.conversation_images where conversation_id = :c');
    $stmt->execute([':c' => $convId]);
    expect((int) $stmt->fetchColumn())->toBe(0);
    $dir = CHAT_ATTACHMENTS_ROOT . "/chat/{$convId}/images";
    $left = is_dir($dir) ? iterator_count(new FilesystemIterator($dir)) : 0;
    expect($left)->toBe(0, 'the already-written file of a failed batch must be removed');
});

it('copies an attachment into a new note at FULL RESOLUTION without re-encoding', function (): void {
    [$headers, $nookId] = chatAttachSetup('444444444444');
    $convId = chatAttachConversation($headers);
    $png = chatAttachPng(1280, 720, 100);
    $attachment = chatAttachStore($headers, $convId, [$png], $nookId)[0];

    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images/from-attachment", $headers, json_str([
        'attachment_id' => $attachment['id'],
        'title' => 'Screenshot',
    ]));

    expect($res['status'])->toBe(200, $res['body']);
    $body = json_body($res);
    expect($body['mode'])->toBe('new_note');
    expect($body['note']['title'])->toBe('Screenshot');
    expect($body['file']['filesize'])->toBe(strlen($png));
    expect($body['embed'])->toContain($body['note']['id']);

    // The copy is byte-identical to the attachment (not a resize, not a
    // re-encode) and sits at its own object key.
    $path = CHAT_ATTACHMENTS_ROOT . '/' . $body['file']['object_key'];
    expect(file_get_contents($path))->toBe($png);
    expect(chatAttachDims($path))->toBe([1280, 720]);
    expect($body['file']['object_key'])->not->toStartWith("chat/{$convId}/");
});

it('attaches a stored attachment to an existing note as a new version', function (): void {
    [$headers, $nookId] = chatAttachSetup('555555555555');
    $convId = chatAttachConversation($headers);

    $v1 = chatAttachPng(64, 64, 110);
    $v2 = chatAttachPng(96, 96, 111);
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode($v1),
        'media_type' => 'image/png',
    ]));
    $noteId = (string) json_body($noteRes)['note']['id'];

    $attachment = chatAttachStore($headers, $convId, [$v2])[0];
    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images/from-attachment", $headers, json_str([
        'attachment_id' => $attachment['id'],
        'note_id' => $noteId,
    ]));

    expect($res['status'])->toBe(200, $res['body']);
    $body = json_body($res);
    expect($body['mode'])->toBe('attached');
    expect($body['file']['file_version'])->toBe(2);
    expect(file_get_contents(CHAT_ATTACHMENTS_ROOT . '/' . $body['file']['object_key']))->toBe($v2);

    // The attachment itself is untouched by the copy — it is a copy, not a move.
    expect(App::handle('GET', "/api/conversations/{$convId}/images/{$attachment['id']}", $headers, '')['body'])->toBe($v2);
});

it('refuses an attachment_id from someone else\'s conversation', function (): void {
    [$ownerHeaders, $ownerNook] = chatAttachSetup('666666666666');
    $ownerConv = chatAttachConversation($ownerHeaders);
    $attachment = chatAttachStore($ownerHeaders, $ownerConv, [chatAttachPng(8, 8, 120)])[0];

    [$strangerHeaders, $strangerNook] = chatAttachSetup('777777777777');
    $res = App::handle('POST', "/api/nooks/{$strangerNook}/chat-images/from-attachment", $strangerHeaders, json_str([
        'attachment_id' => $attachment['id'],
    ]));

    expect($res['status'])->toBe(404);
    expect(json_body($res)['error'])->toContain('not found');
    expect($ownerNook)->not->toBe('');
});

it('requires attachment_id on the copy route', function (): void {
    [$headers, $nookId] = chatAttachSetup('888888888888');
    $res = App::handle('POST', "/api/nooks/{$nookId}/chat-images/from-attachment", $headers, json_str(['title' => 'x']));
    expect($res['status'])->toBe(400);
    expect(json_body($res)['error'])->toContain('attachment_id');
});

it('deleting the conversation removes the rows AND the bytes from disk', function (): void {
    [$headers] = chatAttachSetup('999999999999');
    $convId = chatAttachConversation($headers);
    chatAttachStore($headers, $convId, [chatAttachPng(8, 8, 130), chatAttachPng(8, 8, 131)]);

    $dir = CHAT_ATTACHMENTS_ROOT . "/chat/{$convId}/images";
    expect(is_dir($dir))->toBeTrue('precondition: bytes exist on disk');

    $res = App::handle('DELETE', "/api/conversations/{$convId}", $headers, '');
    expect($res['status'])->toBe(200, $res['body']);

    // The DB cascade handles the rows…
    $stmt = test_pdo()->prepare('select count(*) from global.conversation_images where conversation_id = :c');
    $stmt->execute([':c' => $convId]);
    expect((int) $stmt->fetchColumn())->toBe(0);
    // …but nothing cascades on a filesystem, so the controller must unlink.
    expect(is_dir($dir))->toBeFalse('a deleted conversation must not leave attachment bytes behind');
    expect(is_dir(CHAT_ATTACHMENTS_ROOT . "/chat/{$convId}"))->toBeFalse();
});

it('deleting all conversations sweeps every attachment', function (): void {
    [$headers] = chatAttachSetup('aaaa11111111');
    $convA = chatAttachConversation($headers, 'A');
    $convB = chatAttachConversation($headers, 'B');
    chatAttachStore($headers, $convA, [chatAttachPng(8, 8, 140)]);
    chatAttachStore($headers, $convB, [chatAttachPng(8, 8, 141)]);

    expect(App::handle('DELETE', '/api/conversations', $headers, '')['status'])->toBe(200);

    $stmt = test_pdo()->prepare('select count(*) from global.conversation_images');
    expect((int) $stmt->fetchColumn())->toBe(0);
    expect(is_dir(CHAT_ATTACHMENTS_ROOT . '/chat'))->toBeFalse();
});

it('leaves another conversation\'s attachments alone when one is deleted', function (): void {
    [$headers] = chatAttachSetup('bbbb22222222');
    $convA = chatAttachConversation($headers, 'Keep');
    $convB = chatAttachConversation($headers, 'Drop');
    $kept = chatAttachStore($headers, $convA, [chatAttachPng(8, 8, 150)])[0];
    $dropped = chatAttachStore($headers, $convB, [chatAttachPng(8, 8, 151)])[0];

    expect(App::handle('DELETE', "/api/conversations/{$convB}", $headers, '')['status'])->toBe(200);

    // The survivor is untouched: its row and its bytes both survive.
    $keptRes = App::handle('GET', "/api/conversations/{$convA}/images/{$kept['id']}", $headers, '');
    expect($keptRes['status'])->toBe(200, 'the kept conversation must still be able to read its own attachment');
    expect($keptRes['body'])->toBe(chatAttachPng(8, 8, 150), 'full-resolution bytes, not a trun');
    expect(is_dir(CHAT_ATTACHMENTS_ROOT . "/chat/{$convA}/images"))->toBeTrue();

    // …while the deleted conversation's row and bytes are both gone. The
    // directory sweep must be scoped to that one conversation id.
    $droppedRes = App::handle('GET', "/api/conversations/{$convB}/images/{$dropped['id']}", $headers, '');
    expect($droppedRes['status'])->toBe(404);
    expect(is_dir(CHAT_ATTACHMENTS_ROOT . "/chat/{$convB}"))->toBeFalse();
});

it('serves the current image of a note so the model can actually see it', function (): void {
    [$headers, $nookId] = chatAttachSetup('cccc33333333');
    $png = chatAttachPng(300, 200, 160);

    $create = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode($png),
        'media_type' => 'image/png',
        'filename' => 'portrait.png',
    ]));
    expect($create['status'])->toBe(200, $create['body']);
    $noteId = (string) json_body($create)['note']['id'];

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/image", $headers, '');

    expect($res['status'])->toBe(200);
    expect($res['body'])->toBe($png);
    expect($res['headers']['X-Image-Mime'] ?? '')->toContain('image/png');
    expect($res['headers']['X-Image-Filename'] ?? '')->toBe('portrait.png');
});

it('returns the NEWEST version of a note image, and 404s for a note without one', function (): void {
    [$headers, $nookId] = chatAttachSetup('dddd44444444');
    $convId = chatAttachConversation($headers);

    $create = App::handle('POST', "/api/nooks/{$nookId}/chat-images", $headers, json_str([
        'image_data' => base64_encode(chatAttachPng(40, 40, 170)),
        'media_type' => 'image/png',
    ]));
    $noteId = (string) json_body($create)['note']['id'];

    // Attach a chat attachment on top → the endpoint must follow the version pointer.
    $png2 = chatAttachPng(50, 50, 171);
    $attachment = chatAttachStore($headers, $convId, [$png2])[0];
    App::handle('POST', "/api/nooks/{$nookId}/chat-images/from-attachment", $headers, json_str([
        'attachment_id' => $attachment['id'],
        'note_id' => $noteId,
    ]));

    $res = App::handle('GET', "/api/nooks/{$nookId}/notes/{$noteId}/image", $headers, '');
    expect($res['body'])->toBe($png2, 'must be v2, not the replaced v1');

    $plain = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_str(['title' => 'no file']));
    $plainId = (string) json_body($plain)['note']['id'];
    $missing = App::handle('GET', "/api/nooks/{$nookId}/notes/{$plainId}/image", $headers, '');
    expect($missing['status'])->toBe(404);
    expect(json_body($missing)['error'])->toContain('no attached file');
});

it('does not leak a note image across nooks', function (): void {
    [$ownerHeaders, $ownerNook] = chatAttachSetup('eeee55555555');
    $png = chatAttachPng(20, 20, 180);
    $create = App::handle('POST', "/api/nooks/{$ownerNook}/chat-images", $ownerHeaders, json_str([
        'image_data' => base64_encode($png),
        'media_type' => 'image/png',
    ]));
    $noteId = (string) json_body($create)['note']['id'];

    [$strangerHeaders, $strangerNook] = chatAttachSetup('ffff66666666');
    // Right note id, wrong nook → not found, not someone else's picture.
    expect(App::handle('GET', "/api/nooks/{$strangerNook}/notes/{$noteId}/image", $strangerHeaders, '')['status'])->toBe(404);
});
