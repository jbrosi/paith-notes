<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
use Paith\Notes\Shared\Env;
use PDO;
use Throwable;

final class HealthController
{
    public function health(Request $request, Context $context): Response
    {
        static $counter = 0;

        if (!is_int($counter)) {
            $counter = 0;
        }

        $currentCounter = $counter;
        $counter++;

        return JsonResponse::ok([
            'service' => 'paith-notes',
            'ts' => gmdate('c'),
            'counter' => $currentCounter,
        ]);
    }

    public function db(Request $request, Context $context): Response
    {
        $databaseUrl = Env::get('DATABASE_URL');
        if ($databaseUrl === '') {
            return JsonResponse::error('DATABASE_URL is not set', 500);
        }

        $availableDrivers = [];
        try {
            $availableDrivers = PDO::getAvailableDrivers();
        } catch (Throwable) {
            $availableDrivers = [];
        }

        if (!in_array('pgsql', $availableDrivers, true)) {
            return JsonResponse::error('PDO pgsql driver is not installed (pdo_pgsql extension missing)', 500, [
                'pdo_drivers' => $availableDrivers,
            ]);
        }

        $parts = parse_url($databaseUrl);
        if ($parts === false) {
            return JsonResponse::error('DATABASE_URL is invalid', 500);
        }

        $host = $parts['host'] ?? '';
        $port = (int)($parts['port'] ?? 5432);
        $user = $parts['user'] ?? '';
        $pass = $parts['pass'] ?? '';
        $dbName = ltrim((string)($parts['path'] ?? ''), '/');

        if ($host === '' || $user === '' || $dbName === '') {
            return JsonResponse::error('DATABASE_URL must include host, user, and database name', 500);
        }

        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $host, $port, $dbName);

        try {
            $pdo = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 2,
            ]);

            $versionStmt = $pdo->query('select version()');
            $serverVersion = null;
            if ($versionStmt !== false) {
                $serverVersion = $versionStmt->fetchColumn();
            }

            return JsonResponse::ok([
                'db' => [
                    'driver' => 'pgsql',
                    'host' => $host,
                    'port' => $port,
                    'name' => $dbName,
                    'server_version' => $serverVersion,
                ],
            ]);
        } catch (Throwable $e) {
            return JsonResponse::error($e->getMessage(), 500, [
                'type' => get_class($e),
                'pdo_drivers' => $availableDrivers,
            ]);
        }
    }
}
