<?php
declare(strict_types=1);

namespace Paith\Notes\Worker;

use Aws\S3\S3Client;
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
            $pdo->exec("\n                create table if not exists jobs (\n                    id bigserial primary key,\n                    queue text not null default 'default',\n                    payload jsonb not null default '{}'::jsonb,\n                    status text not null default 'queued',\n                    available_at timestamptz not null default now(),\n                    locked_at timestamptz null,\n                    locked_by text null,\n                    attempts int not null default 0,\n                    last_error text null,\n                    created_at timestamptz not null default now(),\n                    updated_at timestamptz not null default now()\n                );\n            ");

            $pdo->exec('create index if not exists jobs_status_available_idx on jobs (status, available_at)');
            $pdo->exec('create index if not exists jobs_locked_at_idx on jobs (locked_at)');
        };

        $workerId = sprintf('worker-%s-%d', gethostname() ?: 'unknown', getmypid());

        while (true) {
            try {
                $pdo = $connect();
                $ensureSchema($pdo);

                $pdo->beginTransaction();

                $stmt = $pdo->prepare("\n                    select id, payload\n                        from jobs\n                        where status = 'queued'\n                            and available_at <= now()\n                        order by id\n                        for update skip locked\n                        limit 1\n                ");
                $stmt->execute();
                $job = $stmt->fetch(PDO::FETCH_ASSOC);

                if ($job === false) {
                    $pdo->commit();
                    sleep(2);
                    continue;
                }

                $jobId = (int)$job['id'];

                $lock = $pdo->prepare("\n                    update jobs\n                    set status = 'processing',\n                        locked_at = now(),\n                        locked_by = :locked_by,\n                        attempts = attempts + 1,\n                        updated_at = now()\n                    where id = :id\n                ");
                $lock->execute([
                    ':locked_by' => $workerId,
                    ':id' => $jobId,
                ]);

                $pdo->commit();

                fwrite(STDOUT, sprintf("%s picked job %d\n", $workerId, $jobId));

                $done = $connect()->prepare("\n                    update jobs\n                        set status = 'done',\n                            updated_at = now()\n                        where id = :id\n                ");
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
