<?php
declare(strict_types=1);

$databaseUrl = getenv('DATABASE_URL') ?: '';
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
    $pdo->exec( "
        create table if not exists jobs (
            id bigserial primary key,
            queue text not null default 'default',
            payload jsonb not null default '{}'::jsonb,
            status text not null default 'queued',
            available_at timestamptz not null default now(),
            locked_at timestamptz null,
            locked_by text null,
            attempts int not null default 0,
            last_error text null,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
        );
    ");

    $pdo->exec('create index if not exists jobs_status_available_idx on jobs (status, available_at)');
    $pdo->exec('create index if not exists jobs_locked_at_idx on jobs (locked_at)');
};

$workerId = sprintf('worker-%s-%d', gethostname() ?: 'unknown', getmypid());

while (true) {
    try {
        $pdo = $connect();
        $ensureSchema($pdo);

        $pdo->beginTransaction();

        $stmt = $pdo->prepare("
            select id, payload
                from jobs
                where status = 'queued'
                    and available_at <= now()
                order by id
                for update skip locked
                limit 1
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
            update jobs
            set status = 'processing',
                locked_at = now(),
                locked_by = :locked_by
                attempts = attempts + 1
                updated_at = now()
            where id = :id
        ");
        $lock->execute([
            ':locked_by' => $workerId,
            ':id' => $jobId,
        ]);

        $pdo->commit();

        fwrite(STDOUT, sprintf("%s picked job %d\n", $workerId, $jobId));

        $done = $connect()->prepare("
        update jobs
            set status = 'done',
                updated_at = now()
            where id = :id
        ");
        $done->execute([':id' => $jobId]);
    } catch (Throwable $e) {
        fwrite(STDERR, sprintf("worker error: %s (%s)\n", $e->getMessage(), get_class($e)));
        sleep(2);
    }
}
