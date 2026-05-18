<?php

declare(strict_types=1);

use Paith\Notes\Shared\Db\DatabaseUrl;
use Paith\Notes\Shared\Db\GlobalSchema;

function test_pdo(): PDO
{
    $databaseUrl = getenv('DATABASE_URL');
    if (!is_string($databaseUrl)) {
        $databaseUrl = '';
    }
    $cfg = DatabaseUrl::toPdoConfig($databaseUrl);

    $pdo = new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_TIMEOUT => 2,
    ]);

    // Set audit user for triggers (use system user in tests)
    $pdo->exec("select set_config('app.user_id', 'deadc0ff-ee00-4000-8000-000000000000', false)");

    return $pdo;
}

function ensure_worker_schema(PDO $pdo): void
{
    GlobalSchema::ensure($pdo);
}
