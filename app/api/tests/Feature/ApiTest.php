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
