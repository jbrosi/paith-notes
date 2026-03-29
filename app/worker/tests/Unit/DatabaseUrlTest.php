<?php

declare(strict_types=1);

use Paith\Notes\Shared\Db\DatabaseUrl;

test('parses a basic postgresql URL', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgresql://myuser:mypass@localhost:5432/mydb');

    expect($cfg['dsn'])->toBe('pgsql:host=localhost;port=5432;dbname=mydb');
    expect($cfg['user'])->toBe('myuser');
    expect($cfg['pass'])->toBe('mypass');
});

test('accepts postgres:// scheme as well as postgresql://', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgres://user:pass@db:5432/paith');

    expect($cfg['dsn'])->toStartWith('pgsql:');
    expect($cfg['user'])->toBe('user');
});

test('defaults port to 5432 when omitted', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgresql://user:pass@localhost/mydb');

    expect($cfg['dsn'])->toContain('port=5432');
});

test('includes sslmode when provided as query parameter', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgresql://user:pass@host/db?sslmode=verify-full');

    expect($cfg['dsn'])->toContain('sslmode=verify-full');
});

test('includes multiple ssl query parameters', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgresql://user:pass@host/db?sslmode=verify-full&sslrootcert=/etc/ssl/ca.crt');

    expect($cfg['dsn'])->toContain('sslmode=verify-full');
    expect($cfg['dsn'])->toContain('sslrootcert=/etc/ssl/ca.crt');
});

test('strips semicolons from DSN values to prevent injection', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgresql://user:pass@host/db?sslmode=verify;full');

    expect($cfg['dsn'])->not->toContain(';full');
    expect($cfg['dsn'])->toContain('sslmode=verifyfull');
});

test('ignores unknown query parameters', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('postgresql://user:pass@host/db?unknown=value&sslmode=disable');

    expect($cfg['dsn'])->not->toContain('unknown');
    expect($cfg['dsn'])->toContain('sslmode=disable');
});

test('throws when DATABASE_URL is empty', function (): void {
    DatabaseUrl::toPdoConfig('');
})->throws(RuntimeException::class, 'DATABASE_URL is not set');

test('throws when scheme is not postgresql', function (): void {
    DatabaseUrl::toPdoConfig('mysql://user:pass@localhost/db');
})->throws(RuntimeException::class, 'DATABASE_URL must start with postgresql://');

test('throws when URL is unparseable', function (): void {
    DatabaseUrl::toPdoConfig('postgresql:///mydb');
})->throws(RuntimeException::class, 'DATABASE_URL is invalid');

test('throws when user is missing', function (): void {
    DatabaseUrl::toPdoConfig('postgresql://localhost/mydb');
})->throws(RuntimeException::class, 'DATABASE_URL must include host, user, and database name');

test('throws when database name is missing', function (): void {
    DatabaseUrl::toPdoConfig('postgresql://user:pass@localhost/');
})->throws(RuntimeException::class, 'DATABASE_URL must include host, user, and database name');

test('trims whitespace from URL before parsing', function (): void {
    $cfg = DatabaseUrl::toPdoConfig('  postgresql://user:pass@localhost/db  ');

    expect($cfg['dsn'])->toStartWith('pgsql:');
});
