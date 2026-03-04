<?php

declare(strict_types=1);

namespace Paith\Notes\Worker;

use Paith\Notes\Shared\Db\GlobalSchema;
use Paith\Notes\Shared\Env;
use PDO;
use Throwable;

final class Runner
{
    public static function run(): void
    {
        $databaseUrl = Env::get('DATABASE_URL');
        if ($databaseUrl === '') {
            fwrite(STDERR, "DATABASE_URL is not set\n");
            exit(1);
        }

        $parts = parse_url($databaseUrl);
        if ($parts === false) {
            fwrite(STDERR, "DATABASE_URL is invalid\n");
            exit(1);
        }

        $host = $parts['host'] ?? '';
        $port = (int)($parts['port'] ?? 5432);
        $user = $parts['user'] ?? '';
        $pass = $parts['pass'] ?? '';
        $dbName = ltrim((string)($parts['path'] ?? ''), '/');

        if ($host === '' || $user === '' || $dbName === '') {
            fwrite(STDERR, "DATABASE_URL must include host, user, and database name\n");
            exit(1);
        }

        $dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $host, $port, $dbName);

        $connect = static function () use ($dsn, $user, $pass): PDO {
            return new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 2,
            ]);
        };

        $ensureSchema = static function (PDO $pdo): void {
            GlobalSchema::ensure($pdo);
        };

        $workerId = sprintf('worker-%s-%d', gethostname() ?: 'unknown', getmypid());

        $lastCleanupAt = 0;

        while (true) {
            try {
                $pdo = $connect();
                $ensureSchema($pdo);

                $pdo->beginTransaction();

                $stmt = $pdo->prepare("
                    select 
                        id, 
                        payload 
                    from global.jobs 
                    where 
                        status = 'queued' 
                        and available_at <= now() 
                    order by id
                    for update skip locked limit 1
                ");
                $stmt->execute();
                /** @var array{id: mixed, payload: mixed}|false $job */
                $job = $stmt->fetch(PDO::FETCH_ASSOC);

                if ($job === false) {
                    $pdo->commit();

                    $now = time();
                    if ($now - $lastCleanupAt >= 30) {
                        $lastCleanupAt = $now;
                        try {
                            self::cleanupExpiredUploads($connect());
                        } catch (Throwable $e) {
                            fwrite(STDERR, sprintf("cleanup error: %s (%s)\n", $e->getMessage(), get_class($e)));
                        }
                    }

                    sleep(2);
                    continue;
                }

                $jobIdRaw = $job['id'];
                if (!is_numeric($jobIdRaw)) {
                    $pdo->rollBack();
                    throw new \RuntimeException('job id is not numeric');
                }
                $jobId = (int)$jobIdRaw;

                $lock = $pdo->prepare("
                    update global.jobs
                        set status = 'processing',
                        locked_at = now(),
                        locked_by = :locked_by,
                        attempts = attempts + 1,
                        updated_at = now()
                    where id = :id;
                ");
                $lock->execute([
                    ':locked_by' => $workerId,
                    ':id' => $jobId,
                ]);

                $pdo->commit();

                fwrite(STDOUT, sprintf("%s picked job %d\n", $workerId, $jobId));

                $done = $connect()->prepare("
                    update global.jobs set 
                        status = 'done',
                        updated_at = now()
                    where id = :id;
                ");
                $done->execute([':id' => $jobId]);
            } catch (Throwable $e) {
                fwrite(STDERR, sprintf("worker error: %s (%s)\n", $e->getMessage(), get_class($e)));
                sleep(2);
            }
        }
    }

    private static function cleanupExpiredUploads(PDO $pdo): void
    {
        $pdo->beginTransaction();
        try {
            $sel = $pdo->prepare(
                "select id, temp_object_key from global.file_uploads where finalized_at is null and expires_at <= now() order by expires_at limit 100 for update skip locked"
            );
            $sel->execute();
            $rows = $sel->fetchAll(PDO::FETCH_ASSOC);

            if ($rows === []) {
                $pdo->commit();
                return;
            }

            $del = $pdo->prepare('delete from global.file_uploads where id = :id');

            foreach ($rows as $r) {
                if (!is_array($r)) {
                    continue;
                }

                $id = is_scalar($r['id'] ?? null) ? (string)$r['id'] : '';
                $key = is_scalar($r['temp_object_key'] ?? null) ? (string)$r['temp_object_key'] : '';
                if ($id === '' || $key === '') {
                    continue;
                }
                if (!str_starts_with($key, 'tmp/')) {
                    continue;
                }

                $path = '/data/' . ltrim($key, '/');
                if (is_file($path)) {
                    @unlink($path);
                }

                $del->execute([':id' => $id]);
            }

            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }
}
