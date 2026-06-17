<?php

declare(strict_types=1);

use Paith\Notes\Api\Http\App;

it('reports nothing for strong unique secrets', function (): void {
    $issues = App::secretIssues([
        'SESSION_SECRET'    => bin2hex(random_bytes(32)),
        'FILES_SIGNING_KEY' => bin2hex(random_bytes(32)),
    ]);
    expect($issues)->toBe([]);
});

it('flags missing secrets as fatal', function (): void {
    $issues = App::secretIssues([
        'SESSION_SECRET'    => '',
        'FILES_SIGNING_KEY' => bin2hex(random_bytes(32)),
    ]);
    expect($issues)->toHaveCount(1);
    expect($issues[0]['key'])->toBe('SESSION_SECRET');
    expect($issues[0]['severity'])->toBe('fatal');
});

it('warns on .env.example placeholder strings', function (): void {
    $cases = [
        'change-me',
        'replace-me-with-a-long-random-string',
        'paste-here-after-openssl-rand-hex-32',
        'CHANGE-ME', // case-insensitive
    ];
    foreach ($cases as $placeholder) {
        $issues = App::secretIssues(['SESSION_SECRET' => $placeholder]);
        expect($issues)->toHaveCount(1, "placeholder '{$placeholder}' should have been flagged");
        expect($issues[0]['severity'])->toBe('warning');
        expect($issues[0]['reason'])->toBe('placeholder');
    }
});

it('warns on values shorter than 32 chars (not via placeholder check)', function (): void {
    $issues = App::secretIssues([
        'SESSION_SECRET' => 'short-but-not-a-placeholder',
    ]);
    expect($issues)->toHaveCount(1);
    expect($issues[0]['severity'])->toBe('warning');
    expect($issues[0]['reason'])->toBe('short');
});

it('flags placeholder before short (placeholder is the more useful signal)', function (): void {
    // 'replace-me' is 10 chars — also fails the length check. We want the
    // placeholder reason because it tells the operator WHY it's bad.
    $issues = App::secretIssues(['SESSION_SECRET' => 'replace-me']);
    expect($issues)->toHaveCount(1);
    expect($issues[0]['reason'])->toBe('placeholder');
});
