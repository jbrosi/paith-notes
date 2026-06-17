<?php

declare(strict_types=1);

// This file is referenced from phpunit.xml's `bootstrap` attribute, so PHPUnit
// guarantees it runs once before any test code loads — earlier and more
// reliably than top-level code in tests/Pest.php.
//
// Lock FILES_DATA_PATH to a writable per-PID tempdir, ignoring whatever the
// shell handed us. On GitHub Actions runners the env propagation from
// scripts/ci-test-php.sh hasn't been reliable, and the production default
// (/data) isn't writable by the runner user, which surfaced as
// `mkdir(): Permission denied` in NookExportTest and a silent
// file_put_contents() failure leading to a finalize 404 in ApiTest.
$dataPath = sys_get_temp_dir() . '/paith-api-tests-' . getmypid();
@mkdir($dataPath . '/tmp', 0777, true);
@mkdir($dataPath . '/notes', 0777, true);
putenv('FILES_DATA_PATH=' . $dataPath);
fwrite(STDERR, "[bootstrap] FILES_DATA_PATH={$dataPath}\n");

// FILES_SIGNING_KEY is required by Env::require in production. Tests don't run
// App::run() (they call App::handle() directly), so the boot-time hard fail
// doesn't fire — but anything exercising UrlSigner::fromEnv() would still
// throw. Set a deterministic non-production value if the operator hasn't.
if ((string)getenv('FILES_SIGNING_KEY') === '') {
    putenv('FILES_SIGNING_KEY=test-files-signing-key-not-for-production-use-only');
}

require_once __DIR__ . '/../vendor/autoload.php';
