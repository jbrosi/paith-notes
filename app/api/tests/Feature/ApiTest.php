<?php
declare(strict_types=1);

use Paith\Notes\Api\Http\App;

beforeEach(function (): void {
    putenv('KEYCLOAK_ENABLED=0');
    $pdo = test_pdo();
    ensure_global_schema($pdo);

    $pdo->exec('truncate table global.sessions, global.auth_states, global.nook_members, global.nooks, global.users cascade');
    // Re-insert the AI system user (truncated above)
    $pdo->exec("insert into global.users (id, first_name, last_name) values ('deadc0ff-ee00-4000-8000-000000000000', 'AI', 'Assistant') on conflict (id) do nothing");
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

    // Default nook is auto-created
    expect((string)($initialListData['nooks'][0]['name'] ?? ''))->toBe('My Notes');

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
});

it('can rename a nook', function (): void {
    $userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    App::handle('GET', '/api/me', $headers, '');

    $create = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Original Name'], JSON_UNESCAPED_SLASHES));
    expect($create['status'])->toBe(200);
    $nookId = (string)(json_decode($create['body'], true)['nook']['id'] ?? '');
    expect($nookId)->not->toBe('');

    // Rename
    $update = App::handle(
        'PUT',
        '/api/nooks/' . $nookId,
        $headers,
        json_encode(['name' => 'New Name'], JSON_UNESCAPED_SLASHES)
    );
    expect($update['status'])->toBe(200);
    $updateData = json_decode($update['body'], true);
    expect($updateData)->toBeArray();
    expect((string)($updateData['nook']['name'] ?? ''))->toBe('New Name');

    // Verify in list
    $list = App::handle('GET', '/api/nooks', $headers, '');
    $listData = json_decode($list['body'], true);
    $found = array_values(array_filter(
        $listData['nooks'],
        static fn (mixed $n): bool => is_array($n) && (($n['id'] ?? '') === $nookId)
    ));
    expect(count($found))->toBe(1);
    expect((string)($found[0]['name'] ?? ''))->toBe('New Name');

    // Empty name rejected
    $empty = App::handle(
        'PUT',
        '/api/nooks/' . $nookId,
        $headers,
        json_encode(['name' => ''], JSON_UNESCAPED_SLASHES)
    );
    expect($empty['status'])->toBe(400);
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

	// Notes list is a summary response and must not include full content.
	foreach ($listNotesData['notes'] as $n) {
		expect($n)->toBeArray();
		expect(array_key_exists('content', $n))->toBe(false);
	}

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
    $stmt = $pdo->prepare('select title, content from global.notes where id = :id and nook_id = :nook_id');
    $stmt->execute([':id' => $noteId, ':nook_id' => $nookId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    expect($row)->toBeArray();
    expect((string)($row['title'] ?? ''))->toBe('Hello 2');
    expect((string)($row['content'] ?? ''))->toBe('World 2');

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

it('can update a note type key and description', function (): void {
	$userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
	$headers = [
		'X-Nook-User' => $userId,
		'X-Nook-Groups' => 'paith/notes',
	];

	App::handle('GET', '/api/me', $headers, '');

	$createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Types'], JSON_UNESCAPED_SLASHES));
	expect($createNook['status'])->toBe(200);
	$createNookData = json_decode($createNook['body'], true);
	expect($createNookData)->toBeArray();
	$nookId = (string)($createNookData['nook']['id'] ?? '');
	expect($nookId)->not->toBe('');

	$createType = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/note-types',
		$headers,
		json_encode([
			'key' => 'topic',
			'label' => 'Topic',
			'description' => 'Short',
			'parent_id' => '',
			'applies_to' => 'notes',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createType['status'])->toBe(200);
	$createTypeData = json_decode($createType['body'], true);
	expect($createTypeData)->toBeArray();
	$typeId = (string)($createTypeData['type']['id'] ?? '');
	expect($typeId)->not->toBe('');
	expect((string)($createTypeData['type']['key'] ?? ''))->toBe('topic');
	expect((string)($createTypeData['type']['description'] ?? ''))->toBe('Short');

	$updateType = App::handle(
		'PUT',
		'/api/nooks/' . $nookId . '/note-types/' . $typeId,
		$headers,
		json_encode([
			'key' => 'topics',
			'label' => 'Topics',
			'description' => 'Longer text',
			'parent_id' => '',
			'applies_to' => 'notes',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($updateType['status'])->toBe(200);
	$updateTypeData = json_decode($updateType['body'], true);
	expect($updateTypeData)->toBeArray();
	expect((string)($updateTypeData['type']['id'] ?? ''))->toBe($typeId);
	expect((string)($updateTypeData['type']['key'] ?? ''))->toBe('topics');
	expect((string)($updateTypeData['type']['label'] ?? ''))->toBe('Topics');
	expect((string)($updateTypeData['type']['description'] ?? ''))->toBe('Longer text');

	$pdo = test_pdo();
	$stmt = $pdo->prepare('select key, label, description from global.note_types where id = :id and nook_id = :nook_id');
	$stmt->execute([':id' => $typeId, ':nook_id' => $nookId]);
	$row = $stmt->fetch(PDO::FETCH_ASSOC);
	expect($row)->toBeArray();
	expect((string)($row['key'] ?? ''))->toBe('topics');
	expect((string)($row['label'] ?? ''))->toBe('Topics');
	expect((string)($row['description'] ?? ''))->toBe('Longer text');
});

it('can create link predicates, set rules, and link notes with dates (duplicates allowed)', function (): void {
	$userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
	$headers = [
		'X-Nook-User' => $userId,
		'X-Nook-Groups' => 'paith/notes',
	];

	App::handle('GET', '/api/me', $headers, '');

	$createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Links'], JSON_UNESCAPED_SLASHES));
	expect($createNook['status'])->toBe(200);
	$createNookData = json_decode($createNook['body'], true);
	expect($createNookData)->toBeArray();
	$nookId = (string)($createNookData['nook']['id'] ?? '');
	expect($nookId)->not->toBe('');

	// Create a type hierarchy: Person <- Customer
	$createPersonType = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/note-types',
		$headers,
		json_encode([
			'key' => 'person',
			'label' => 'Person',
			'description' => '',
			'parent_id' => '',
			'applies_to' => 'notes',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createPersonType['status'])->toBe(200);
	$createPersonTypeData = json_decode($createPersonType['body'], true);
	expect($createPersonTypeData)->toBeArray();
	$personTypeId = (string)($createPersonTypeData['type']['id'] ?? '');
	expect($personTypeId)->not->toBe('');

	$createCustomerType = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/note-types',
		$headers,
		json_encode([
			'key' => 'customer',
			'label' => 'Customer',
			'description' => '',
			'parent_id' => $personTypeId,
			'applies_to' => 'notes',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createCustomerType['status'])->toBe(200);
	$createCustomerTypeData = json_decode($createCustomerType['body'], true);
	expect($createCustomerTypeData)->toBeArray();
	$customerTypeId = (string)($createCustomerTypeData['type']['id'] ?? '');
	expect($customerTypeId)->not->toBe('');

	// Create predicate
	$createPredicate = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/link-predicates',
		$headers,
		json_encode([
			'key' => 'owns',
			'forward_label' => 'owns',
			'reverse_label' => 'owned by',
			'supports_start_date' => true,
			'supports_end_date' => true,
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createPredicate['status'])->toBe(200);
	$createPredicateData = json_decode($createPredicate['body'], true);
	expect($createPredicateData)->toBeArray();
	$predicateId = (string)($createPredicateData['predicate']['id'] ?? '');
	expect($predicateId)->not->toBe('');

	// Rules: source must be Person (including subtypes), target can be anything
	$replaceRules = App::handle(
		'PUT',
		'/api/nooks/' . $nookId . '/link-predicates/' . $predicateId . '/rules',
		$headers,
		json_encode([
			'rules' => [[
				'source_type_id' => $personTypeId,
				'target_type_id' => '',
				'include_source_subtypes' => true,
				'include_target_subtypes' => true,
			]],
		], JSON_UNESCAPED_SLASHES)
	);
	expect($replaceRules['status'])->toBe(200);
	$replaceRulesData = json_decode($replaceRules['body'], true);
	expect($replaceRulesData)->toBeArray();
	expect($replaceRulesData['saved'])->toBe(true);

	// Create notes
	$createAlice = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes',
		$headers,
		json_encode([
			'title' => 'Alice',
			'content' => '...',
			'type' => 'anything',
			'type_id' => $customerTypeId,
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createAlice['status'])->toBe(200);
	$createAliceData = json_decode($createAlice['body'], true);
	expect($createAliceData)->toBeArray();
	$aliceId = (string)($createAliceData['note']['id'] ?? '');
	expect($aliceId)->not->toBe('');

	$createCar = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes',
		$headers,
		json_encode([
			'title' => 'Car',
			'content' => '...',
			'type' => 'anything',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createCar['status'])->toBe(200);
	$createCarData = json_decode($createCar['body'], true);
	expect($createCarData)->toBeArray();
	$carId = (string)($createCarData['note']['id'] ?? '');
	expect($carId)->not->toBe('');

	// Create link with dates
	$createLink1 = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes/' . $aliceId . '/links',
		$headers,
		json_encode([
			'predicate_id' => $predicateId,
			'target_note_id' => $carId,
			'start_date' => '2020-01-01',
			'end_date' => '2020-12-31',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createLink1['status'])->toBe(200);
	$createLink1Data = json_decode($createLink1['body'], true);
	expect($createLink1Data)->toBeArray();
	$linkId1 = (string)($createLink1Data['link']['id'] ?? '');
	expect($linkId1)->not->toBe('');
	expect((string)($createLink1Data['link']['start_date'] ?? ''))->toBe('2020-01-01');
	expect((string)($createLink1Data['link']['end_date'] ?? ''))->toBe('2020-12-31');

	// Create another identical link (duplicates allowed)
	$createLink2 = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes/' . $aliceId . '/links',
		$headers,
		json_encode([
			'predicate_id' => $predicateId,
			'target_note_id' => $carId,
			'start_date' => '2021-01-01',
			'end_date' => '2021-06-30',
		], JSON_UNESCAPED_SLASHES)
	);
	expect($createLink2['status'])->toBe(200);
	$createLink2Data = json_decode($createLink2['body'], true);
	expect($createLink2Data)->toBeArray();
	$linkId2 = (string)($createLink2Data['link']['id'] ?? '');
	expect($linkId2)->not->toBe('');
	expect($linkId2)->not->toBe($linkId1);

	// List links for Alice
	$list = App::handle('GET', '/api/nooks/' . $nookId . '/notes/' . $aliceId . '/links?direction=out', $headers, '');
	expect($list['status'])->toBe(200);
	$listData = json_decode($list['body'], true);
	expect($listData)->toBeArray();
	expect($listData['links'])->toBeArray();
	expect(count($listData['links']))->toBe(2);

	// Delete one link
	$del = App::handle('DELETE', '/api/nooks/' . $nookId . '/notes/' . $aliceId . '/links/' . $linkId1, $headers, '');
	expect($del['status'])->toBe(200);
	$delData = json_decode($del['body'], true);
	expect($delData)->toBeArray();
	expect($delData['deleted'])->toBe(true);
	expect((string)($delData['link_id'] ?? ''))->toBe($linkId1);

	$list2 = App::handle('GET', '/api/nooks/' . $nookId . '/notes/' . $aliceId . '/links?direction=out', $headers, '');
	expect($list2['status'])->toBe(200);
	$listData2 = json_decode($list2['body'], true);
	expect($listData2)->toBeArray();
	expect($listData2['links'])->toBeArray();
	expect(count($listData2['links']))->toBe(1);
});


it('denies PUT to /files/tmp when upload is missing or does not match', function (): void {
    $prevEnabled = getenv('KEYCLOAK_ENABLED');
    putenv('KEYCLOAK_ENABLED=0');

    $userId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    App::handle('GET', '/api/me', $headers, '');

    $createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Auth PUT'], JSON_UNESCAPED_SLASHES));
    expect($createNook['status'])->toBe(200);
    $createNookData = json_decode($createNook['body'], true);
    expect($createNookData)->toBeArray();
    $nookId = (string)($createNookData['nook']['id'] ?? '');
    expect($nookId)->not->toBe('');

    $missing = App::handle(
        'GET',
        '/api/files/auth',
        $headers + [
            'X-Original-Method' => 'PUT',
            'X-Original-URI' => '/files/tmp/11111111-1111-4111-8111-111111111111',
        ],
        ''
    );
    expect($missing['status'])->toBe(404);

    // Fetch the seeded File type and its file attribute
    $typesRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types', $headers, '');
    $typesData = json_decode($typesRes['body'], true);
    $fileType = null;
    foreach ($typesData['types'] ?? [] as $t) {
        if (($t['key'] ?? '') === 'file') { $fileType = $t; break; }
    }
    expect($fileType)->not->toBeNull();
    $fileTypeId = $fileType['id'];

    $attrsRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $fileTypeId . '/attributes', $headers, '');
    $attrsData = json_decode($attrsRes['body'], true);
    $fileAttr = null;
    foreach ($attrsData['attributes'] ?? [] as $a) {
        if (($a['kind'] ?? '') === 'file') { $fileAttr = $a; break; }
    }
    expect($fileAttr)->not->toBeNull();
    $fileAttrId = $fileAttr['id'];

    $uploadUrl = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/file/attr-upload-url',
        $headers,
        json_encode([
            'filename' => 'example.txt',
            'extension' => 'txt',
            'filesize' => 3,
            'mime_type' => 'text/plain',
            'checksum' => '',
            'type_id' => $fileTypeId,
            'attribute_id' => $fileAttrId,
        ], JSON_UNESCAPED_SLASHES)
    );
    expect($uploadUrl['status'])->toBe(200);
    $uploadData = json_decode($uploadUrl['body'], true);
    expect($uploadData)->toBeArray();
    $uploadId = (string)($uploadData['upload_id'] ?? '');
    expect($uploadId)->not->toBe('');

    $wrong = App::handle(
        'GET',
        '/api/files/auth',
        $headers + [
            'X-Original-Method' => 'PUT',
            'X-Original-URI' => '/files/tmp/22222222-2222-4222-8222-222222222222',
        ],
        ''
    );
    expect($wrong['status'])->toBe(404);

    $ok = App::handle(
        'GET',
        '/api/files/auth',
        $headers + [
            'X-Original-Method' => 'PUT',
            'X-Original-URI' => '/files/tmp/' . $uploadId,
        ],
        ''
    );
    expect($ok['status'])->toBe(200);

    putenv('KEYCLOAK_ENABLED=' . (is_string($prevEnabled) ? $prevEnabled : ''));
});

it('attribute-based file upload and download', function (): void {
    $prevEnabled = getenv('KEYCLOAK_ENABLED');
    putenv('KEYCLOAK_ENABLED=0');

    $userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];

    App::handle('GET', '/api/me', $headers, '');

    $createNook = App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Files'], JSON_UNESCAPED_SLASHES));
    expect($createNook['status'])->toBe(200);
    $createNookData = json_decode($createNook['body'], true);
    expect($createNookData)->toBeArray();
    $nookId = (string)($createNookData['nook']['id'] ?? '');
    expect($nookId)->not->toBe('');

    // Fetch seeded File type and its file attribute
    $typesRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types', $headers, '');
    $typesData = json_decode($typesRes['body'], true);
    $fileType = null;
    foreach ($typesData['types'] ?? [] as $t) {
        if (($t['key'] ?? '') === 'file') { $fileType = $t; break; }
    }
    expect($fileType)->not->toBeNull();
    $fileTypeId = $fileType['id'];

    $attrsRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $fileTypeId . '/attributes', $headers, '');
    $attrsData = json_decode($attrsRes['body'], true);
    $fileAttr = null;
    foreach ($attrsData['attributes'] ?? [] as $a) {
        if (($a['kind'] ?? '') === 'file') { $fileAttr = $a; break; }
    }
    expect($fileAttr)->not->toBeNull();
    $fileAttrId = $fileAttr['id'];

    $uploadUrl = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/file/attr-upload-url',
        $headers,
        json_encode([
            'filename' => 'example.txt',
            'extension' => 'txt',
            'filesize' => 3,
            'mime_type' => 'text/plain',
            'checksum' => '',
            'type_id' => $fileTypeId,
            'attribute_id' => $fileAttrId,
        ], JSON_UNESCAPED_SLASHES)
    );
    expect($uploadUrl['status'])->toBe(200);
    $uploadData = json_decode($uploadUrl['body'], true);
    expect($uploadData)->toBeArray();
    expect((string)($uploadData['upload_url'] ?? ''))->toContain('http');
    expect((string)($uploadData['upload_url'] ?? ''))->toContain('/files/tmp/');
    expect((string)($uploadData['upload_id'] ?? ''))->not->toBe('');

    // Simulate the nginx PUT
    $uploadId = (string)($uploadData['upload_id'] ?? '');

    $claimPut = App::handle(
        'GET',
        '/api/files/auth',
        $headers + [
            'X-Original-Method' => 'PUT',
            'X-Original-URI' => '/files/tmp/' . $uploadId,
        ],
        ''
    );
    expect($claimPut['status'])->toBe(200);

    $dataPath = trim((string)getenv('FILES_DATA_PATH'));
    if ($dataPath === '') {
        $dataPath = '/data';
    }
    $tmpDir = rtrim($dataPath, '/') . '/tmp';
    if (!is_dir($tmpDir)) {
        @mkdir($tmpDir, 0777, true);
    }
    file_put_contents($tmpDir . '/' . $uploadId, 'abc');

    // Finalize creates the note with file attribute
    $finalize = App::handle(
        'POST',
        '/api/nooks/' . $nookId . '/file/attr-finalize',
        $headers,
        json_encode([
            'upload_id' => $uploadId,
            'type_id' => $fileTypeId,
            'attribute_id' => $fileAttrId,
        ], JSON_UNESCAPED_SLASHES)
    );
    expect($finalize['status'])->toBe(200);
    $finalizeData = json_decode($finalize['body'], true);
    expect($finalizeData)->toBeArray();
    $noteId = (string)($finalizeData['note']['id'] ?? '');
    expect($noteId)->not->toBe('');
    expect((string)($finalizeData['note']['title'] ?? ''))->toBe('example.txt');
    expect((string)($finalizeData['note']['type_id'] ?? ''))->toBe($fileTypeId);

    // Verify file metadata in note_files
    $pdo = test_pdo();
    $stmt = $pdo->prepare('select object_key, filename, filesize, mime_type, checksum from global.note_files where note_id = :note_id');
    $stmt->execute([':note_id' => $noteId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    expect($row)->toBeArray();
    expect((string)($row['filename'] ?? ''))->toBe('example.txt');
    expect((int)($row['filesize'] ?? 0))->toBe(3);
    expect((string)($row['mime_type'] ?? ''))->toBe('text/plain');

    // Download via attribute endpoint
    $downloadUrl = App::handle(
        'GET',
        '/api/nooks/' . $nookId . '/notes/' . $noteId . '/attributes/' . $fileAttrId . '/file/download-url',
        $headers,
        ''
    );
    expect($downloadUrl['status'])->toBe(200);
    $downloadData = json_decode($downloadUrl['body'], true);
    expect($downloadData)->toBeArray();
    expect((string)($downloadData['download_url'] ?? ''))->toContain('http');
    expect(isset($downloadData['expires_in']))->toBeTrue();

    putenv('KEYCLOAK_ENABLED=' . (is_string($prevEnabled) ? $prevEnabled : ''));
});

it('embedded image note links are included in mentions (empty alt)', function (): void {
	$prevEnabled = getenv('KEYCLOAK_ENABLED');
	putenv('KEYCLOAK_ENABLED=0');

	$userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
	$headers = [
		'X-Nook-User' => $userId,
		'X-Nook-Groups' => 'paith/notes',
	];

	App::handle('GET', '/api/me', $headers, '');

	$createNook = App::handle(
		'POST',
		'/api/nooks',
		$headers,
		json_encode(['name' => 'Mentions'], JSON_UNESCAPED_SLASHES)
	);
	expect($createNook['status'])->toBe(200);
	$createNookData = json_decode($createNook['body'], true);
	expect($createNookData)->toBeArray();
	$nookId = (string)($createNookData['nook']['id'] ?? '');
	expect($nookId)->not->toBe('');

	$target = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes',
		$headers,
		json_encode([
			'title' => 'Image',
			'content' => '',
			'type' => 'file',
			'properties' => [],
		], JSON_UNESCAPED_SLASHES)
	);
	expect($target['status'])->toBe(200);
	$targetData = json_decode($target['body'], true);
	expect($targetData)->toBeArray();
	$targetId = (string)($targetData['note']['id'] ?? '');
	expect($targetId)->not->toBe('');

	$source = App::handle(
		'POST',
		'/api/nooks/' . $nookId . '/notes',
		$headers,
		json_encode([
			'title' => 'Source',
			'content' => 'Here is an embed: ![1.00](note:' . $targetId . ' "fff")',
			'type' => 'anything',
			'properties' => [],
		], JSON_UNESCAPED_SLASHES)
	);
	expect($source['status'])->toBe(200);
	$sourceData = json_decode($source['body'], true);
	expect($sourceData)->toBeArray();
	$sourceId = (string)($sourceData['note']['id'] ?? '');
	expect($sourceId)->not->toBe('');

	$mentions = App::handle(
		'GET',
		'/api/nooks/' . $nookId . '/notes/' . $sourceId . '/mentions',
		$headers,
		''
	);
	expect($mentions['status'])->toBe(200);
	$mentionsData = json_decode($mentions['body'], true);
	expect($mentionsData)->toBeArray();

	$outgoing = $mentionsData['outgoing'] ?? null;
	expect($outgoing)->toBeArray();
	$found = false;
	foreach ($outgoing as $m) {
		if (!is_array($m)) {
			continue;
		}
		if ((string)($m['note_id'] ?? '') === $targetId) {
			$found = true;
			break;
		}
	}
	expect($found)->toBeTrue();

	putenv('KEYCLOAK_ENABLED=' . (is_string($prevEnabled) ? $prevEnabled : ''));
});

it('auth login redirects to keycloak and persists validated redirect', function (): void {
	$prevEnabled = getenv('KEYCLOAK_ENABLED');
	$prevBase = getenv('KEYCLOAK_BASE_URL');
	$prevRealm = getenv('KEYCLOAK_REALM');
	$prevClientId = getenv('KEYCLOAK_CLIENT_ID');
	$prevSecret = getenv('KEYCLOAK_CLIENT_SECRET');

	putenv('KEYCLOAK_ENABLED=1');
	putenv('KEYCLOAK_BASE_URL=https://keycloak.example');
	putenv('KEYCLOAK_REALM=test');
	putenv('KEYCLOAK_CLIENT_ID=notes');
	putenv('KEYCLOAK_CLIENT_SECRET=secret');

	try {
		$res = App::handle('GET', '/api/auth/login?redirect=%2Fnooks%2Fabc', [], '');
		expect($res['status'])->toBe(302);
		expect($res['headers'])->toHaveKey('Location');
		$location = (string)$res['headers']['Location'];
		expect($location)->toContain('/protocol/openid-connect/auth');

		$parts = parse_url($location);
		expect($parts)->toBeArray();
		parse_str((string)($parts['query'] ?? ''), $q);
		expect($q)->toBeArray();
		expect(isset($q['state']))->toBeTrue();
		$state = (string)($q['state'] ?? '');
		expect($state)->not->toBe('');

		$pdo = test_pdo();
		$stmt = $pdo->prepare('select redirect_to from global.auth_states where state = :state');
		$stmt->execute([':state' => $state]);
		$row = $stmt->fetch(PDO::FETCH_ASSOC);
		expect($row)->toBeArray();
		expect((string)($row['redirect_to'] ?? ''))->toBe('/nooks/abc');

		$res2 = App::handle('GET', '/api/auth/login?redirect=https%3A%2F%2Fevil.example%2F', [], '');
		expect($res2['status'])->toBe(302);
		$location2 = (string)$res2['headers']['Location'];
		$parts2 = parse_url($location2);
		parse_str((string)($parts2['query'] ?? ''), $q2);
		$state2 = (string)($q2['state'] ?? '');
		expect($state2)->not->toBe('');

		$stmt2 = $pdo->prepare('select redirect_to from global.auth_states where state = :state');
		$stmt2->execute([':state' => $state2]);
		$row2 = $stmt2->fetch(PDO::FETCH_ASSOC);
		expect($row2)->toBeArray();
		expect((string)($row2['redirect_to'] ?? ''))->toBe('/');
	} finally {
		putenv('KEYCLOAK_ENABLED=' . (is_string($prevEnabled) ? $prevEnabled : ''));
		putenv('KEYCLOAK_BASE_URL=' . (is_string($prevBase) ? $prevBase : ''));
		putenv('KEYCLOAK_REALM=' . (is_string($prevRealm) ? $prevRealm : ''));
		putenv('KEYCLOAK_CLIENT_ID=' . (is_string($prevClientId) ? $prevClientId : ''));
		putenv('KEYCLOAK_CLIENT_SECRET=' . (is_string($prevSecret) ? $prevSecret : ''));
	}
});

it('auth logout clears cookie and deletes session', function (): void {
	$pdo = test_pdo();

	// Create a user using the dev header auth path.
	$headers = [
		'X-Nook-User' => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		'X-Nook-Groups' => 'paith/notes',
	];
	$me = App::handle('GET', '/api/me', $headers, '');
	expect($me['status'])->toBe(200);

	$sessionId = '99999999-9999-4999-8999-999999999999';
	$pdo->prepare("insert into global.sessions (id, user_id, token_encrypted, expires_at) values (:id, :user_id, 'x', now() + interval '1 day')")
		->execute([':id' => $sessionId, ':user_id' => $headers['X-Nook-User']]);

	$res = App::handle('POST', '/api/auth/logout', ['Cookie' => 'paith_session=' . $sessionId], '');
	expect($res['status'])->toBe(200);
	expect($res['headers'])->toHaveKey('Set-Cookie');
	$setCookie = (string)$res['headers']['Set-Cookie'];
	expect($setCookie)->toContain('paith_session=');
	expect($setCookie)->toContain('Max-Age=0');
	expect($setCookie)->toContain('HttpOnly');

	$stmt = $pdo->prepare('select count(*) from global.sessions where id = :id');
	$stmt->execute([':id' => $sessionId]);
	expect((int)$stmt->fetchColumn())->toBe(0);
});

// ─── Type Attributes ────────────────────────────────────────────────────────

it('can create, list, update, and delete type attributes', function (): void {
    $userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];
    App::handle('GET', '/api/me', $headers, '');

    $nookId = json_decode(App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Attr Test']))['body'], true)['nook']['id'];

    // Create a type
    $typeRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'book', 'label' => 'Book',
    ]));
    expect($typeRes['status'])->toBe(200);
    $typeId = json_decode($typeRes['body'], true)['type']['id'];

    // Create a text attribute
    $createAttr = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, json_encode([
        'name' => 'Author', 'kind' => 'text',
    ]));
    expect($createAttr['status'])->toBe(200);
    $attrData = json_decode($createAttr['body'], true)['attribute'];
    expect($attrData['name'])->toBe('Author');
    expect($attrData['kind'])->toBe('text');
    expect($attrData['inherited'])->toBe(false);
    $authorAttrId = $attrData['id'];

    // Create a number attribute
    $createRating = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, json_encode([
        'name' => 'Rating', 'kind' => 'number',
    ]));
    expect($createRating['status'])->toBe(200);
    $ratingAttrId = json_decode($createRating['body'], true)['attribute']['id'];

    // Create a select attribute
    $createGenre = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, json_encode([
        'name' => 'Genre', 'kind' => 'select', 'config' => ['options' => ['sci-fi', 'fantasy', 'mystery']],
    ]));
    expect($createGenre['status'])->toBe(200);
    $genreAttrId = json_decode($createGenre['body'], true)['attribute']['id'];

    // List attributes — should have 3
    $listRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, '');
    expect($listRes['status'])->toBe(200);
    $attrs = json_decode($listRes['body'], true)['attributes'];
    expect(count($attrs))->toBe(3);

    // Update: rename Author to Writer, change kind to text (same)
    $updateRes = App::handle('PUT', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes/' . $authorAttrId, $headers, json_encode([
        'name' => 'Writer', 'kind' => 'text',
    ]));
    expect($updateRes['status'])->toBe(200);
    expect(json_decode($updateRes['body'], true)['attribute']['name'])->toBe('Writer');

    // Delete Rating
    $deleteRes = App::handle('DELETE', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes/' . $ratingAttrId, $headers, '');
    expect($deleteRes['status'])->toBe(200);

    // List should now have 2
    $listRes2 = App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, '');
    $attrs2 = json_decode($listRes2['body'], true)['attributes'];
    expect(count($attrs2))->toBe(2);

    // Duplicate name should fail
    $dupRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, json_encode([
        'name' => 'Writer', 'kind' => 'text',
    ]));
    expect($dupRes['status'])->toBe(409);

    // Select without options should fail
    $badSelect = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeId . '/attributes', $headers, json_encode([
        'name' => 'Status', 'kind' => 'select',
    ]));
    expect($badSelect['status'])->toBe(400);
});

it('attribute inheritance works across type hierarchy', function (): void {
    $userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];
    App::handle('GET', '/api/me', $headers, '');

    $nookId = json_decode(App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Inherit Test']))['body'], true)['nook']['id'];

    // Create parent type with an attribute
    $parentRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'media', 'label' => 'Media',
    ]));
    $parentId = json_decode($parentRes['body'], true)['type']['id'];

    App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $parentId . '/attributes', $headers, json_encode([
        'name' => 'Year', 'kind' => 'number',
    ]));

    // Create child type with its own attribute
    $childRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'movie', 'label' => 'Movie', 'parent_id' => $parentId,
    ]));
    $childId = json_decode($childRes['body'], true)['type']['id'];

    App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $childId . '/attributes', $headers, json_encode([
        'name' => 'Director', 'kind' => 'text',
    ]));

    // List child attributes — should see both Year (inherited) and Director (own)
    $listRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $childId . '/attributes', $headers, '');
    $attrs = json_decode($listRes['body'], true)['attributes'];
    expect(count($attrs))->toBe(2);

    $names = array_map(fn($a) => $a['name'], $attrs);
    sort($names);
    expect($names)->toBe(['Director', 'Year']);

    $inherited = array_filter($attrs, fn($a) => $a['inherited']);
    $own = array_filter($attrs, fn($a) => !$a['inherited']);
    expect(count($inherited))->toBe(1);
    expect(count($own))->toBe(1);
    expect(array_values($inherited)[0]['name'])->toBe('Year');
    expect(array_values($own)[0]['name'])->toBe('Director');

    // Cannot create attribute with same name as inherited one
    $dupRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $childId . '/attributes', $headers, json_encode([
        'name' => 'Year', 'kind' => 'text',
    ]));
    expect($dupRes['status'])->toBe(409);

    // Cannot delete inherited attribute from child
    $yearId = array_values($inherited)[0]['id'];
    $delInherited = App::handle('DELETE', '/api/nooks/' . $nookId . '/note-types/' . $childId . '/attributes/' . $yearId, $headers, '');
    expect($delInherited['status'])->toBe(404);
});

it('note attributes are stored and type switch moves values to archive', function (): void {
    $userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];
    App::handle('GET', '/api/me', $headers, '');

    $nookId = json_decode(App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Switch Test']))['body'], true)['nook']['id'];

    // Create two types with different attributes
    $typeARes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'type-a', 'label' => 'Type A',
    ]));
    $typeAId = json_decode($typeARes['body'], true)['type']['id'];
    $attrARes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeAId . '/attributes', $headers, json_encode([
        'name' => 'Color', 'kind' => 'text',
    ]));
    $colorAttrId = json_decode($attrARes['body'], true)['attribute']['id'];

    $typeBRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'type-b', 'label' => 'Type B',
    ]));
    $typeBId = json_decode($typeBRes['body'], true)['type']['id'];
    $attrBRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types/' . $typeBId . '/attributes', $headers, json_encode([
        'name' => 'Size', 'kind' => 'number',
    ]));
    $sizeAttrId = json_decode($attrBRes['body'], true)['attribute']['id'];

    // Create note with Type A and set Color attribute
    $noteRes = App::handle('POST', '/api/nooks/' . $nookId . '/notes', $headers, json_encode([
        'title' => 'Test Note',
        'content' => '',
        'type_id' => $typeAId,
        'attributes' => [$colorAttrId => 'red'],
    ]));
    expect($noteRes['status'])->toBe(200);
    $note = json_decode($noteRes['body'], true)['note'];
    $noteId = $note['id'];
    expect($note['attributes'][$colorAttrId] ?? null)->toBe('red');

    // Switch to Type B — Color should move to archive
    $switchRes = App::handle('PUT', '/api/nooks/' . $nookId . '/notes/' . $noteId, $headers, json_encode([
        'title' => 'Test Note',
        'content' => '',
        'type_id' => $typeBId,
        'attributes' => [$sizeAttrId => 42],
    ]));
    expect($switchRes['status'])->toBe(200);
    $switched = json_decode($switchRes['body'], true)['note'];
    expect($switched['attributes'][$sizeAttrId] ?? null)->toBe(42);
    expect($switched['attributes'][$colorAttrId] ?? null)->toBeNull();
    expect($switched['archive'][$colorAttrId] ?? null)->toBe('red');

    // Switch back to Type A — Color should restore from archive, Size goes to archive
    $switchBack = App::handle('PUT', '/api/nooks/' . $nookId . '/notes/' . $noteId, $headers, json_encode([
        'title' => 'Test Note',
        'content' => '',
        'type_id' => $typeAId,
    ]));
    expect($switchBack['status'])->toBe(200);
    $restored = json_decode($switchBack['body'], true)['note'];
    expect($restored['attributes'][$colorAttrId] ?? null)->toBe('red');
    expect($restored['archive'][$sizeAttrId] ?? null)->toBe(42);
});

it('type deletion is blocked when children exist', function (): void {
    $userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];
    App::handle('GET', '/api/me', $headers, '');

    $nookId = json_decode(App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Delete Test']))['body'], true)['nook']['id'];

    $parentRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'parent', 'label' => 'Parent',
    ]));
    $parentId = json_decode($parentRes['body'], true)['type']['id'];

    $childRes = App::handle('POST', '/api/nooks/' . $nookId . '/note-types', $headers, json_encode([
        'key' => 'child', 'label' => 'Child', 'parent_id' => $parentId,
    ]));
    $childId = json_decode($childRes['body'], true)['type']['id'];

    // Cannot delete parent while child exists
    $delParent = App::handle('DELETE', '/api/nooks/' . $nookId . '/note-types/' . $parentId, $headers, '');
    expect($delParent['status'])->toBe(400);

    // Can delete child
    $delChild = App::handle('DELETE', '/api/nooks/' . $nookId . '/note-types/' . $childId, $headers, '');
    expect($delChild['status'])->toBe(200);

    // Now can delete parent
    $delParent2 = App::handle('DELETE', '/api/nooks/' . $nookId . '/note-types/' . $parentId, $headers, '');
    expect($delParent2['status'])->toBe(200);
});

it('default file and graph types are seeded for new nooks', function (): void {
    $userId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    $headers = [
        'X-Nook-User' => $userId,
        'X-Nook-Groups' => 'paith/notes',
    ];
    App::handle('GET', '/api/me', $headers, '');

    $nookId = json_decode(App::handle('POST', '/api/nooks', $headers, json_encode(['name' => 'Seed Test']))['body'], true)['nook']['id'];

    // List types — should include seeded File and Graph View types
    $typesRes = App::handle('GET', '/api/nooks/' . $nookId . '/note-types', $headers, '');
    $types = json_decode($typesRes['body'], true)['types'];
    $keys = array_map(fn($t) => $t['key'], $types);
    expect(in_array('file', $keys, true))->toBeTrue();
    expect(in_array('graph', $keys, true))->toBeTrue();

    // File type should have a file attribute
    $fileType = null;
    foreach ($types as $t) { if ($t['key'] === 'file') { $fileType = $t; break; } }
    $fileAttrs = json_decode(App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $fileType['id'] . '/attributes', $headers, '')['body'], true)['attributes'];
    $fileKinds = array_map(fn($a) => $a['kind'], $fileAttrs);
    expect(in_array('file', $fileKinds, true))->toBeTrue();

    // Graph type should have a graph attribute
    $graphType = null;
    foreach ($types as $t) { if ($t['key'] === 'graph') { $graphType = $t; break; } }
    $graphAttrs = json_decode(App::handle('GET', '/api/nooks/' . $nookId . '/note-types/' . $graphType['id'] . '/attributes', $headers, '')['body'], true)['attributes'];
    $graphKinds = array_map(fn($a) => $a['kind'], $graphAttrs);
    expect(in_array('graph', $graphKinds, true))->toBeTrue();
});
