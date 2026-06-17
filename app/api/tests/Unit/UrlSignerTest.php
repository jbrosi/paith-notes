<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\Auth\UrlSigner;

it('produces a base64url-encoded HMAC-SHA256 (43 chars, no padding)', function (): void {
    $signer = new UrlSigner('test-key-0123456789abcdef0123456789abcdef');
    $sig = $signer->sign(
        objectKey: 'notes/abc/files/def/ghi/v1',
        exp: 1700000000,
        sessionId: '12345678-1234-4123-8123-123456789012',
        filename: 'photo.png',
        contentType: 'image/png',
        inline: true,
    );
    expect($sig)->toBeString();
    expect(strlen($sig))->toBe(43); // 32 bytes of HMAC → 43 base64url chars (no =)
    expect($sig)->not->toContain('=');
    expect($sig)->not->toContain('+');
    expect($sig)->not->toContain('/');
});

it('is deterministic across calls with the same inputs', function (): void {
    $signer = new UrlSigner('shared-secret');
    $args = ['k', 1700000000, 'sid', 'a.txt', 'text/plain', false];
    expect($signer->sign(...$args))->toBe($signer->sign(...$args));
});

it('verifies a signature it just produced', function (): void {
    $signer = new UrlSigner('shared-secret');
    $args = ['k', 1700000000, 'sid', 'a.txt', 'text/plain', false];
    $sig = $signer->sign(...$args);
    expect($signer->verify($sig, ...$args))->toBeTrue();
});

it('rejects a tampered signature on any field', function (): void {
    $signer = new UrlSigner('shared-secret');
    $sig = $signer->sign('k', 1700000000, 'sid', 'a.txt', 'text/plain', false);

    // each field perturbed independently
    expect($signer->verify($sig, 'kk', 1700000000, 'sid', 'a.txt', 'text/plain', false))->toBeFalse();
    expect($signer->verify($sig, 'k', 1700000001, 'sid', 'a.txt', 'text/plain', false))->toBeFalse();
    expect($signer->verify($sig, 'k', 1700000000, 'other-sid', 'a.txt', 'text/plain', false))->toBeFalse();
    expect($signer->verify($sig, 'k', 1700000000, 'sid', 'b.txt', 'text/plain', false))->toBeFalse();
    expect($signer->verify($sig, 'k', 1700000000, 'sid', 'a.txt', 'text/html', false))->toBeFalse();
    expect($signer->verify($sig, 'k', 1700000000, 'sid', 'a.txt', 'text/plain', true))->toBeFalse();
});

it('rejects a signature produced under a different key', function (): void {
    $args = ['k', 1700000000, 'sid', 'a.txt', 'text/plain', false];
    $sigA = (new UrlSigner('key-a'))->sign(...$args);
    expect((new UrlSigner('key-b'))->verify($sigA, ...$args))->toBeFalse();
});

it('produces a known fixture (cross-check against qjs handler)', function (): void {
    // This is the contract the qjs handler must match byte-for-byte.
    // If you change the canonical input format here, update files-auth.mjs too
    // and re-pin this fixture.
    $signer = new UrlSigner('cross-check-key');
    $sig = $signer->sign(
        objectKey: 'notes/aaa/files/bbb/ccc/v1',
        exp: 1700000000,
        sessionId: 'deadbeef-dead-4eef-8eef-deadbeefdead',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        inline: false,
    );
    expect($sig)->toBe('pkcwvv4s8C9HlnlxiZwa6ophf1NtAw8EWw1K2qaDAyg');
});
