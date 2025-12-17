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
    $headers = ['X-Nook-User' => $userId];

    $me = App::handle('GET', '/api/me', $headers, '');
    expect($me['status'])->toBe(200);

    $meData = json_decode($me['body'], true);
    expect($meData)->toBeArray();
    expect($meData['user']['id'])->toBe($userId);

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
    expect(count($listData['nooks']))->toBe(1);
    expect($listData['nooks'][0]['name'])->toBe('My First Nook');
});
