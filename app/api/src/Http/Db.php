<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http;

use Paith\Notes\Shared\Db\DatabaseUrl;
use Paith\Notes\Shared\Env;
use PDO;
use RuntimeException;

final class Db
{
    public static function pdoFromEnv(): PDO
    {
        $databaseUrl = Env::get('DATABASE_URL');
        $cfg = DatabaseUrl::toPdoConfig($databaseUrl);

        $pdo = new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_TIMEOUT => 2,
        ]);

        return $pdo;
    }
}
