<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users, global.conversations cascade');
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
});

/** @return array{0: string, 1: array<string, string>} */
function makeUser(string $idPart): array
{
    $userId = "eeeeeeee-eeee-4eee-8eee-{$idPart}";
    $headers = ['X-Nook-User' => $userId, 'X-Nook-Groups' => 'paith/notes'];
    App::handle('GET', '/api/me', $headers, '');
    return [$userId, $headers];
}

function createConversation(array $headers, string $title): string
{
    $res = App::handle('POST', '/api/conversations', $headers, json_encode(['title' => $title, 'model' => 'claude-sonnet-5']));
    expect($res['status'])->toBe(200);
    return (string) (json_decode($res['body'], true)['conversation']['id'] ?? '');
}

it('creates conversations scoped to the user without requiring a nook', function (): void {
    [, $headers] = makeUser('aaaaaaaaaaaa');

    $res = App::handle('POST', '/api/conversations', $headers, json_encode(['title' => 'Hello', 'model' => 'claude-sonnet-5']));
    expect($res['status'])->toBe(200);
    $body = json_decode($res['body'], true);
    expect($body['conversation']['title'])->toBe('Hello');
    expect($body['conversation'])->not()->toHaveKey('nook_id');
});

it('lists only the calling users conversations', function (): void {
    [, $aHeaders] = makeUser('111111111111');
    [, $bHeaders] = makeUser('222222222222');

    createConversation($aHeaders, 'A1');
    createConversation($aHeaders, 'A2');
    createConversation($bHeaders, 'B1');

    $aList = json_decode(App::handle('GET', '/api/conversations', $aHeaders, '')['body'], true);
    expect(count($aList['conversations']))->toBe(2);

    $bList = json_decode(App::handle('GET', '/api/conversations', $bHeaders, '')['body'], true);
    expect(count($bList['conversations']))->toBe(1);
    expect($bList['conversations'][0]['title'])->toBe('B1');
});

it('deletes one conversation when called by its owner', function (): void {
    [, $headers] = makeUser('333333333333');
    $convId = createConversation($headers, 'To delete');

    $res = App::handle('DELETE', "/api/conversations/{$convId}", $headers, '');
    expect($res['status'])->toBe(200);

    $list = json_decode(App::handle('GET', '/api/conversations', $headers, '')['body'], true);
    expect($list['conversations'])->toBe([]);
});

it('returns 404 when trying to delete someone elses conversation', function (): void {
    [, $aHeaders] = makeUser('444444444444');
    [, $bHeaders] = makeUser('555555555555');
    $aConvId = createConversation($aHeaders, 'A owned');

    $res = App::handle('DELETE', "/api/conversations/{$aConvId}", $bHeaders, '');
    expect($res['status'])->toBe(404);
});

it('deletes all conversations only for the caller', function (): void {
    [, $aHeaders] = makeUser('666666666666');
    [, $bHeaders] = makeUser('777777777777');
    createConversation($aHeaders, 'A1');
    createConversation($aHeaders, 'A2');
    createConversation($bHeaders, 'B1');

    $res = App::handle('DELETE', '/api/conversations', $aHeaders, '');
    expect($res['status'])->toBe(200);
    expect(json_decode($res['body'], true)['count'])->toBe(2);

    expect(json_decode(App::handle('GET', '/api/conversations', $aHeaders, '')['body'], true)['conversations'])->toBe([]);
    expect(count(json_decode(App::handle('GET', '/api/conversations', $bHeaders, '')['body'], true)['conversations']))->toBe(1);
});

it('rejects linking a note when the caller has no access to the notes nook', function (): void {
    $pdo = test_pdo();
    [, $ownerHeaders] = makeUser('999999999999');
    [, $strangerHeaders] = makeUser('aaaaaaaaaaab');

    // Owner creates a nook + a note in it.
    $nook = json_decode(
        App::handle('POST', '/api/nooks', $ownerHeaders, json_encode(['name' => 'Private']))['body'],
        true,
    );
    $nookId = $nook['nook']['id'];
    $note = json_decode(
        App::handle('POST', "/api/nooks/{$nookId}/notes", $ownerHeaders, json_encode(['title' => 'Secret']))['body'],
        true,
    );
    $noteId = $note['note']['id'];

    // Stranger has their own conversation but no access to the note's nook.
    $strangerConv = createConversation($strangerHeaders, 'Mine');

    $res = App::handle(
        'POST',
        "/api/conversations/{$strangerConv}/note-links",
        $strangerHeaders,
        json_encode(['note_id' => $noteId]),
    );
    expect($res['status'])->toBe(404);

    // No link row created
    $count = (int) $pdo->query("select count(*) from global.note_conversation_links where note_id = " . $pdo->quote($noteId))->fetchColumn();
    expect($count)->toBe(0);
});

it('appends a user + assistant turn and returns the saved block ids', function (): void {
    [, $headers] = makeUser('cccccccccccc');
    $convId = createConversation($headers, 'Append test');

    $body = json_encode([
        'messages' => [
            ['role' => 'user', 'content' => [['type' => 'text', 'text' => 'hi']]],
            [
                'role' => 'assistant',
                'model' => 'claude-sonnet-5',
                'content' => [
                    ['type' => 'text', 'text' => 'hello back'],
                    ['type' => 'tool_use', 'id' => 'toolu_1', 'name' => 'write_memory', 'input' => (object)[]],
                ],
            ],
        ],
    ]);
    $res = App::handle('POST', "/api/conversations/{$convId}/messages", $headers, $body);
    expect($res['status'])->toBe(200);

    $data = json_decode($res['body'], true);
    expect($data['turns'])->toHaveCount(2);
    expect($data['turns'][0]['role'])->toBe('user');
    expect($data['turns'][1]['role'])->toBe('assistant');
    expect($data['turns'][1]['blocks'])->toHaveCount(2);
    // tool_use block exposes its tool_use_id
    expect($data['turns'][1]['blocks'][1]['tool_use_id'])->toBe('toolu_1');
});

it('reads back appended messages as reconstructed turns', function (): void {
    [, $headers] = makeUser('dddddddddddd');
    $convId = createConversation($headers, 'Read test');

    App::handle(
        'POST',
        "/api/conversations/{$convId}/messages",
        $headers,
        json_encode([
            'messages' => [
                ['role' => 'user', 'content' => [['type' => 'text', 'text' => 'first']]],
            ],
        ]),
    );

    $res = App::handle('GET', "/api/conversations/{$convId}/messages", $headers, '');
    expect($res['status'])->toBe(200);
    $data = json_decode($res['body'], true);
    expect($data['messages'])->toHaveCount(1);
    expect($data['messages'][0]['role'])->toBe('user');
    // Blocks are decoded as stdClass objects so empty {} survives the round-trip
    expect($data['messages'][0]['content'][0]['text'])->toBe('first');
});

it('rejects appending messages to someone elses conversation', function (): void {
    [, $aHeaders] = makeUser('eeeeeeeeeeee');
    [, $bHeaders] = makeUser('feeeeeeeeeee');
    $aConv = createConversation($aHeaders, 'A');

    $res = App::handle(
        'POST',
        "/api/conversations/{$aConv}/messages",
        $bHeaders,
        json_encode([
            'messages' => [['role' => 'user', 'content' => [['type' => 'text', 'text' => 'hi']]]],
        ]),
    );
    expect($res['status'])->toBe(404);
});

it('links a note when the caller has nook access', function (): void {
    $pdo = test_pdo();
    [, $headers] = makeUser('111111111112');

    $nookRes = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'NL test']));
    $nookId = json_decode($nookRes['body'], true)['nook']['id'];
    $noteRes = App::handle('POST', "/api/nooks/{$nookId}/notes", $headers, json_encode(['title' => 'A note']));
    $noteId = json_decode($noteRes['body'], true)['note']['id'];

    $convId = createConversation($headers, 'Linker');

    $res = App::handle(
        'POST',
        "/api/conversations/{$convId}/note-links",
        $headers,
        json_encode(['note_id' => $noteId]),
    );
    expect($res['status'])->toBe(200);

    $count = (int) $pdo->query(
        "select count(*) from global.note_conversation_links where note_id = " . $pdo->quote($noteId)
        . " and conversation_id = " . $pdo->quote($convId),
    )->fetchColumn();
    expect($count)->toBe(1);
});

it('exports the callers conversations as a zip', function (): void {
    [, $headers] = makeUser('888888888888');
    createConversation($headers, 'Export me');

    $res = App::handle('GET', '/api/me/conversations/export', $headers, '');
    expect($res['status'])->toBe(200);
    expect($res['headers']['Content-Type'] ?? '')->toBe('application/zip');
    expect($res['headers']['Content-Disposition'] ?? '')->toContain('conversations_');
});
