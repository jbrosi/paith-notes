<?php

declare(strict_types=1);

namespace Paith\Notes\Api\Http\Controller;

use Paith\Notes\Api\Http\Context;
use Paith\Notes\Api\Http\JsonResponse;
use Paith\Notes\Api\Http\Request;
use Paith\Notes\Api\Http\Response;
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

        try {
            $pdo = $context->pdo();
            $versionStmt = $pdo->query('select version()');
            $serverVersion = null;
            if ($versionStmt !== false) {
                $serverVersion = $versionStmt->fetchColumn();
            }

            return JsonResponse::ok([
                'db' => [
                    'driver' => 'pgsql',
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
