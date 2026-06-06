<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Dto\UpdateNoteRequest;
use Paith\Notes\Api\Http\HttpError;

it('treats a missing title as not provided', function (): void {
    $r = UpdateNoteRequest::fromJson([]);
    expect($r->title)->toBeNull();
});

it('treats an empty title as not provided so the controller can fall back to existing', function (): void {
    $r = UpdateNoteRequest::fromJson(['title' => '   ']);
    expect($r->title)->toBeNull();
});

it('takes a non-empty trimmed title', function (): void {
    $r = UpdateNoteRequest::fromJson(['title' => '  hello  ']);
    expect($r->title)->toBe('hello');
});

it('treats missing content as null and present content as the literal string (incl empty)', function (): void {
    expect(UpdateNoteRequest::fromJson([])->content)->toBeNull();
    expect(UpdateNoteRequest::fromJson(['content' => ''])->content)->toBe('');
    expect(UpdateNoteRequest::fromJson(['content' => 'body'])->content)->toBe('body');
});

it('models type_id as tri-state (not provided, clear, set)', function (): void {
    // Not provided
    $r = UpdateNoteRequest::fromJson([]);
    expect($r->typeIdProvided)->toBeFalse();
    expect($r->typeId)->toBeNull();

    // Provided as null → clear
    $r = UpdateNoteRequest::fromJson(['type_id' => null]);
    expect($r->typeIdProvided)->toBeTrue();
    expect($r->typeId)->toBeNull();

    // Provided as empty string → clear
    $r = UpdateNoteRequest::fromJson(['type_id' => '   ']);
    expect($r->typeIdProvided)->toBeTrue();
    expect($r->typeId)->toBeNull();

    // Provided as UUID → set
    $uuid = '11111111-1111-4111-8111-111111111111';
    $r = UpdateNoteRequest::fromJson(['type_id' => $uuid]);
    expect($r->typeIdProvided)->toBeTrue();
    expect($r->typeId)->toBe($uuid);
});

it('rejects a non-uuid type_id', function (): void {
    expect(fn() => UpdateNoteRequest::fromJson(['type_id' => 'not-a-uuid']))
        ->toThrow(HttpError::class, 'type_id must be a UUID');
});

it('keeps attributes null when not provided', function (): void {
    $r = UpdateNoteRequest::fromJson([]);
    expect($r->attributes)->toBeNull();
});

it('strips non-string keys but preserves null values (deletions) in attributes', function (): void {
    $r = UpdateNoteRequest::fromJson([
        'attributes' => [
            'aaaa1111-1111-4111-8111-111111111111' => 'value',
            'aaaa2222-2222-4222-8222-222222222222' => null, // deletion marker
            0 => 'numeric key dropped',
        ],
    ]);
    expect($r->attributes)->toHaveCount(2);
    expect($r->attributes['aaaa1111-1111-4111-8111-111111111111'])->toBe('value');
    expect(array_key_exists('aaaa2222-2222-4222-8222-222222222222', $r->attributes))->toBeTrue();
    expect($r->attributes['aaaa2222-2222-4222-8222-222222222222'])->toBeNull();
});

it('parses expected_version when numeric', function (): void {
    expect(UpdateNoteRequest::fromJson([])->expectedVersion)->toBeNull();
    expect(UpdateNoteRequest::fromJson(['expected_version' => 7])->expectedVersion)->toBe(7);
    expect(UpdateNoteRequest::fromJson(['expected_version' => '9'])->expectedVersion)->toBe(9);
    expect(UpdateNoteRequest::fromJson(['expected_version' => 'nope'])->expectedVersion)->toBeNull();
});
