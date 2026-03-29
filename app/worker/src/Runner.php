<?php

declare(strict_types=1);

namespace Paith\Notes\Worker;

use Paith\Notes\Shared\Db\DatabaseUrl;
use Paith\Notes\Shared\Db\GlobalSchema;
use Paith\Notes\Shared\Env;
use PDO;
use Throwable;

final class Runner
{
    public static function run(): void
    {
        $databaseUrl = Env::get('DATABASE_URL');
        try {
            $cfg = DatabaseUrl::toPdoConfig($databaseUrl);
        } catch (\Throwable $e) {
            fwrite(STDERR, sprintf("%s\n", $e->getMessage()));
            exit(1);
        }

        $connect = static function () use ($cfg): PDO {
            return new PDO($cfg['dsn'], $cfg['user'], $cfg['pass'], [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_TIMEOUT => 2,
            ]);
        };

        // Ensure DB schema once at worker startup (not on every job poll).
        GlobalSchema::ensure($connect());

        $workerId = sprintf('worker-%s-%d', gethostname() ?: 'unknown', getmypid());

        $lastCleanupAt = 0;

        while (true) {
            try {
                $pdo = $connect();

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

    /**
     * Public entry point for testing. In production this is called internally by run().
     */
    public static function runCleanupOnce(PDO $pdo): void
    {
        self::cleanupExpiredUploads($pdo);
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
