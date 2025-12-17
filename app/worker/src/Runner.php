<?php

declare(strict_types=1);

namespace Paith\Notes\Worker;

use Aws\S3\S3Client;
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

        self::ensureBucket();

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
                $job = $stmt->fetch(PDO::FETCH_ASSOC);

                if ($job === false) {
                    $pdo->commit();
                    sleep(2);
                    continue;
                }

                $jobId = (int)$job['id'];

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

    private static function ensureBucket(): void
    {
        $s3Endpoint = Env::get('S3_ENDPOINT');
        $s3AccessKey = Env::get('S3_ACCESS_KEY');
        $s3SecretKey = Env::get('S3_SECRET_KEY');
        $s3Bucket = Env::get('S3_BUCKET');

        if ($s3Endpoint === '' || $s3AccessKey === '' || $s3SecretKey === '' || $s3Bucket === '') {
            fwrite(STDERR, "warning: S3 env not fully set; skipping bucket setup\n");
            return;
        }

        $endpoint = preg_replace('#/+$#', '', $s3Endpoint) ?? $s3Endpoint;

        try {
            $s3 = new S3Client([
                'version' => 'latest',
                'region' => 'us-east-1',
                'endpoint' => $endpoint,
                'use_path_style_endpoint' => true,
                'credentials' => [
                    'key' => $s3AccessKey,
                    'secret' => $s3SecretKey,
                ],
            ]);

            $exists = $s3->doesBucketExist($s3Bucket);
            if (!$exists) {
                $s3->createBucket(['Bucket' => $s3Bucket]);
            }

            fwrite(STDOUT, sprintf("ensured S3 bucket exists: %s (%s)\n", $s3Bucket, $endpoint));
        } catch (Throwable $e) {
            fwrite(STDERR, sprintf("warning: failed to ensure S3 bucket exists: %s (%s)\n", $e->getMessage(), get_class($e)));
        }
    }
}
