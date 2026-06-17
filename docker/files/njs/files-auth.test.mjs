/**
 * Cross-check: the qjs sign() function MUST produce byte-identical output to
 * the PHP UrlSigner. Run via `node files-auth.test.mjs` in CI.
 *
 * The fixture below mirrors the "produces a known fixture (cross-check against
 * qjs handler)" assertion in tests/Unit/UrlSignerTest.php. If you change the
 * canonical input format or the base64url encoding in either file, both this
 * fixture and the PHP fixture must be re-pinned together.
 */

import { sign } from './files-auth.mjs';

const expected = 'pkcwvv4s8C9HlnlxiZwa6ophf1NtAw8EWw1K2qaDAyg';
const actual = sign(
    'cross-check-key',
    'notes/aaa/files/bbb/ccc/v1',
    1700000000,
    'deadbeef-dead-4eef-8eef-deadbeefdead',
    'report.pdf',
    'application/pdf',
    false,
);

if (actual !== expected) {
    console.error(`FAIL: qjs sign output diverged from PHP UrlSigner.`);
    console.error(`  expected: ${expected}`);
    console.error(`  actual:   ${actual}`);
    console.error(`If you changed the canonical input format, update`);
    console.error(`  - docker/files/njs/files-auth.mjs (sign function)`);
    console.error(`  - app/api/src/Http/Auth/UrlSigner.php (sign method)`);
    console.error(`AND re-pin the fixture in both this file and UrlSignerTest.php.`);
    process.exit(1);
}

console.log(`OK qjs sign matches PHP UrlSigner: ${actual}`);
