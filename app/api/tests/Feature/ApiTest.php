<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.nook_members, global.nooks, global.users cascade');
});

it('returns 401 when X-Nook-User is missing', function (): void {
    $res = App::handle('GET', '/api/me', [], '');

    expect($res['status'])->toBe(401);
    expect($res['headers'])->toHaveKey('Content-Type');

    $data = json_decode($res['body'], true);
    expect($data)->toBeArray();
    expect($data['status'])->toBe('error');
});

it('returns 400 when X-Nook-User is not a UUID', function (): void {
    $res = App::handle('GET', '/api/me', ['X-Nook-User' => 'not-a-uuid'], '');

    expect($res['status'])->toBe(400);

    $data = json_decode($res['body'], true);
    expect($data)->toBeArray();
    expect($data['status'])->toBe('error');
});

it('auto-creates a user and can create/list nooks', function (): void {
    $userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $me = App::handle('GET', '/api/me', $headers, '');
    expect($me['status'])->toBe(200);

    $meData = json_decode($me['body'], true);
    expect($meData)->toBeArray();
    expect($meData['user']['id'])->toBe($userId);

    $initialList = App::handle('GET', '/api/nooks', $headers, '');
    expect($initialList['status'])->toBe(200);

    $initialListData = json_decode($initialList['body'], true);
    expect($initialListData)->toBeArray();
    expect($initialListData['nooks'])->toBeArray();
    expect(count($initialListData['nooks']))->toBe(1);

    $personal = array_values(array_filter(
        $initialListData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['is_personal'] ?? false) === true)
    ));
    expect(count($personal))->toBe(1);
    expect($personal[0]['name'])->toBe('Personal');

    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'My First Nook'], JSON_UNESCAPED_SLASHES));
    expect($create['status'])->toBe(200);

    $createData = json_decode($create['body'], true);
    expect($createData)->toBeArray();
    expect($createData['nook']['name'])->toBe('My First Nook');

    $list = App::handle('GET', '/api/nooks', $headers, '');
    expect($list['status'])->toBe(200);

    $listData = json_decode($list['body'], true);
    expect($listData)->toBeArray();
    expect($listData['nooks'])->toBeArray();
    expect(count($listData['nooks']))->toBe(2);

    $personal2 = array_values(array_filter(
        $listData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['is_personal'] ?? false) === true)
    ));
    expect(count($personal2))->toBe(1);
    expect($personal2[0]['name'])->toBe('Personal');

    $created2 = array_values(array_filter(
        $listData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['name'] ?? '') === 'My First Nook')
    ));
    expect(count($created2))->toBe(1);
    expect($created2[0]['is_personal'])->toBe(false);
});

it('can create a note in a nook', function (): void {
    $userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    App::handle('GET', '/api/me', $headers, '');

    $createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Work'], JSON_UNESCAPED_SLASHES));
    expect($createNook['status'])->toBe(200);

    $createNookData = json_decode($createNook['body'], true);
    expect($createNookData)->toBeArray();
    $nookId = (string)($createNookData['nook']['id'] ?? '');
    expect($nookId)->not->toBe('');

    $createNote = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/notes',
        $headers,
        json_encode(['title' => 'Hello', 'content' => 'World'], JSON_UNESCAPED_SLASHES)
    );
    expect($createNote['status'])->toBe(200);

    $createNoteData = json_decode($createNote['body'], true);
    expect($createNoteData)->toBeArray();
    expect($createNoteData['note']['nook_id'])->toBe($nookId);
    expect($createNoteData['note']['title'])->toBe('Hello');
    expect($createNoteData['note']['content'])->toBe('World');
    expect($createNoteData['note']['type'])->toBe('anything');
    expect($createNoteData['note']['properties'])->toBeArray();
    $noteId = (string)($createNoteData['note']['id'] ?? '');
    expect($noteId)->not->toBe('');

	// Create a second note so we can reference it from the first note.
	$createNote2 = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes',
		$headers,
		json_encode(['title' => 'Target', 'content' => ''], JSON_UNESCAPED_SLASHES)
	);
	expect($createNote2['status'])->toBe(200);
	$createNote2Data = json_decode($createNote2['body'], true);
	expect($createNote2Data)->toBeArray();
	$targetNoteId = (string)($createNote2Data['note']['id'] ?? '');
	expect($targetNoteId)->not->toBe('');

	// Update the first note to mention the second note.
	$mentionMd = 'see [Custom Title](note:' . $targetNoteId . ') for details';
	$updateWithMention = App::handle(
		'PUT',
		'/api/nooks/' . $nookId . '/notes/' . $noteId,
		$headers,
		json_encode(['title' => 'Hello 2', 'content' => $mentionMd, 'type' => 'anything', 'properties' => []], JSON_UNESCAPED_SLASHES)
	);
	expect($updateWithMention['status'])->toBe(200);

	$pdoMentions = test_pdo();
	$mentions = $pdoMentions->prepare('select source_note_id, target_note_id, position, link_title from global.note_mentions where source_note_id = :source order by position asc');
	$mentions->execute([':source' => $noteId]);
	$rows = $mentions->fetchAll(PDO::FETCH_ASSOC);
	expect($rows)->toBeArray();
	expect(count($rows))->toBe(1);
	expect((string)($rows[0]['source_note_id'] ?? ''))->toBe($noteId);
	expect((string)($rows[0]['target_note_id'] ?? ''))->toBe($targetNoteId);
	expect((int)($rows[0]['position'] ?? -1))->toBeGreaterThanOrEqual(0);
	expect((string)($rows[0]['link_title'] ?? ''))->toBe('Custom Title');

	// Mentions endpoint: outgoing on source note.
	$mentionsOut = App::handle(
		'GET',
		'/api/nooks/' . $nookId . '/notes/' . $noteId . '/mentions',
		$headers,
		''
	);
	expect($mentionsOut['status'])->toBe(200);
	$mentionsOutData = json_decode($mentionsOut['body'], true);
	expect($mentionsOutData)->toBeArray();
	expect($mentionsOutData['outgoing'])->toBeArray();
	expect($mentionsOutData['incoming'])->toBeArray();
	expect(count($mentionsOutData['outgoing']))->toBe(1);
	expect((string)($mentionsOutData['outgoing'][0]['note_id'] ?? ''))->toBe($targetNoteId);
	expect((string)($mentionsOutData['outgoing'][0]['link_title'] ?? ''))->toBe('Custom Title');

	// Mentions endpoint: incoming on target note.
	$mentionsIn = App::handle(
		'GET',
		'/api/nooks/' . $nookId . '/notes/' . $targetNoteId . '/mentions',
		$headers,
		''
	);
	expect($mentionsIn['status'])->toBe(200);
	$mentionsInData = json_decode($mentionsIn['body'], true);
	expect($mentionsInData)->toBeArray();
	expect($mentionsInData['outgoing'])->toBeArray();
	expect($mentionsInData['incoming'])->toBeArray();
	expect(count($mentionsInData['incoming']))->toBe(1);
	expect((string)($mentionsInData['incoming'][0]['note_id'] ?? ''))->toBe($noteId);
	expect((string)($mentionsInData['incoming'][0]['link_title'] ?? ''))->toBe('Custom Title');

    $listNotes = App::handle('GET', '/api/nooks/' . $nookId . '/notes', $headers, '');
    expect($listNotes['status'])->toBe(200);

    $listNotesData = json_decode($listNotes['body'], true);
    expect($listNotesData)->toBeArray();
    expect($listNotesData['notes'])->toBeArray();
	// We created 2 notes: the original + the target note.
    expect(count($listNotesData['notes']))->toBe(2);

	$ids = array_map(static fn (array $n): string => (string)($n['id'] ?? ''), $listNotesData['notes']);
	expect(in_array($noteId, $ids, true))->toBe(true);
	expect(in_array($targetNoteId, $ids, true))->toBe(true);

	$titles = array_map(static fn (array $n): string => (string)($n['title'] ?? ''), $listNotesData['notes']);
	expect(in_array('Hello 2', $titles, true))->toBe(true);
	expect(in_array('Target', $titles, true))->toBe(true);

	// Remove the mention and ensure mention table is synced (deleted).
	$updateNote = App::handle(
		'PUT',
		'/api/nooks/' . $nookId . '/notes/' . $noteId,
		$headers,
		json_encode(['title' => 'Hello 2', 'content' => 'World 2', 'type' => 'anything', 'properties' => []], JSON_UNESCAPED_SLASHES)
	);
	expect($updateNote['status'])->toBe(200);

	$updateNoteData = json_decode($updateNote['body'], true);
	expect($updateNoteData)->toBeArray();
	expect($updateNoteData['note']['id'])->toBe($noteId);
	expect($updateNoteData['note']['title'])->toBe('Hello 2');
	expect($updateNoteData['note']['content'])->toBe('World 2');
	expect($updateNoteData['note']['type'])->toBe('anything');
	expect($updateNoteData['note']['properties'])->toBeArray();

	$mentions2 = $pdoMentions->prepare('select count(*) from global.note_mentions where source_note_id = :source');
	$mentions2->execute([':source' => $noteId]);
	expect((int)$mentions2->fetchColumn())->toBe(0);

	// Mentions endpoint should now be empty.
	$mentionsOut2 = App::handle(
		'GET',
		'/api/nooks/' . $nookId . '/notes/' . $noteId . '/mentions',
		$headers,
		''
	);
	expect($mentionsOut2['status'])->toBe(200);
	$mentionsOut2Data = json_decode($mentionsOut2['body'], true);
	expect($mentionsOut2Data)->toBeArray();
	expect(count($mentionsOut2Data['outgoing'] ?? []))->toBe(0);

    $pdo = test_pdo();
    $stmt = $pdo->prepare('select title, content, type, properties from global.notes where id = :id and nook_id = :nook_id');
    $stmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    expect($row)->toBeArray();
    expect((string)($row['title'] ?? ''))->toBe('Hello 2');
    expect((string)($row['content'] ?? ''))->toBe('World 2');
    expect((string)($row['type'] ?? ''))->toBe('anything');
    expect($row['properties'])->not->toBeNull();

    $deleteNote = App::handle(
        'DELETE',
        '/api/nooks/' . $nookId . '/notes/' . $noteId,
        $headers,
        ''
    );
    expect($deleteNote['status'])->toBe(200);

    $deleteNoteData = json_decode($deleteNote['body'], true);
    expect($deleteNoteData)->toBeArray();
    expect($deleteNoteData['deleted'])->toBe(true);
    expect($deleteNoteData['note_id'])->toBe($noteId);

    $listNotes2 = App::handle('GET', '/api/nooks/' . $nookId . '/notes', $headers, '');
    expect($listNotes2['status'])->toBe(200);
    $listNotesData2 = json_decode($listNotes2['body'], true);
    expect($listNotesData2)->toBeArray();
    expect($listNotesData2['notes'])->toBeArray();
	// The target note should still exist.
    expect(count($listNotesData2['notes']))->toBe(1);
	expect((string)($listNotesData2['notes'][0]['id'] ?? ''))->toBe($targetNoteId);

    $stmt2 = $pdo->prepare('select count(*) from global.notes where id = :id and nook_id = :nook_id');
    $stmt2->execute([':id' => $noteId, ':nook_id' => $nookId]);
    expect((int)$stmt2->fetchColumn())->toBe(0);
});

it('demoting a person note to anything preserves fields in former_properties and can be restored', function (): void {
	$userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
	$headers = [
		'X-Nook-User' => $userId,
		'X-Nook-Groups' => 'paith/notes',
	];

	App::handle('GET', '/api/me', $headers, '');

	$createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'People'], JSON_UNESCAPED_SLASHES));
	expect($createNook['status'])->toBe(200);
	$createNookData = json_decode($createNook['body'], true);
	expect($createNookData)->toBeArray();
	$nookId = (string)($createNookData['nook']['id'] ?? '');
	expect($nookId)->not->toBe('');

	$createPerson = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes',
		$headers,
		json_encode([
			'title' => 'Ada Lovelace',
			'content' => 'Initial content',
			'type' => 'person',
			'properties' => [
				'first_name' => 'Ada',
				'last_name' => 'Lovelace',
				'date_of_birth' => '1815-12-10',
			],
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createPerson['status'])->toBe(200);
	$createPersonData = json_decode($createPerson['body'], true);
	expect($createPersonData)->toBeArray();
	$noteId = (string)($createPersonData['note']['id'] ?? '');
	expect($noteId)->not->toBe('');
	expect($createPersonData['note']['type'])->toBe('person');

	$demote = App::handle(
		'PUT',
		'/api/nooks/' . $nookId . '/notes/' . $noteId,
		$headers,
		json_encode([
			'title' => 'Ada Lovelace',
			'content' => 'Initial content',
			'type' => 'anything',
			'properties' => [],
		], JSON_UNESCAPED_SLASHES)
	);
	expect($demote['status'])->toBe(200);
	$demoteData = json_decode($demote['body'], true);
	expect($demoteData)->toBeArray();
	expect($demoteData['note']['type'])->toBe('anything');
	expect($demoteData['note']['former_properties'])->toBeArray();
	expect($demoteData['note']['former_properties']['person'])->toBeArray();
	expect((string)($demoteData['note']['former_properties']['person']['first_name'] ?? ''))->toBe('Ada');
	expect((string)($demoteData['note']['former_properties']['person']['last_name'] ?? ''))->toBe('Lovelace');
	expect((string)($demoteData['note']['former_properties']['person']['date_of_birth'] ?? ''))->toBe('1815-12-10');

	$promote = App::handle(
		'PUT',
		'/api/nooks/' . $nookId . '/notes/' . $noteId,
		$headers,
		json_encode([
			'title' => 'Ada Lovelace',
			'content' => 'Initial content',
			'type' => 'person',
			'properties' => [],
		], JSON_UNESCAPED_SLASHES)
	);
	expect($promote['status'])->toBe(200);
	$promoteData = json_decode($promote['body'], true);
	expect($promoteData)->toBeArray();
	expect($promoteData['note']['type'])->toBe('person');
	expect($promoteData['note']['properties'])->toBeArray();
	expect((string)($promoteData['note']['properties']['first_name'] ?? ''))->toBe('Ada');
	expect((string)($promoteData['note']['properties']['last_name'] ?? ''))->toBe('Lovelace');
	expect((string)($promoteData['note']['properties']['date_of_birth'] ?? ''))->toBe('1815-12-10');
});

it('exposes the personal nook via /api/nooks/personal', function (): void {
    $userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    $me = App::handle('GET', '/api/me', $headers, '');
    expect($me['status'])->toBe(200);

    $personal = App::handle('GET', '/api/nooks/personal', $headers, '');
    expect($personal['status'])->toBe(200);

    $personalData = json_decode($personal['body'], true);
    expect($personalData)->toBeArray();
    expect($personalData['nook'])->toBeArray();
    expect($personalData['nook']['id'])->toBeString();
    expect($personalData['nook']['id'])->not->toBe('');
    expect($personalData['nook']['is_personal'])->toBe(true);
});
