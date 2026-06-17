/**
 * Forward-auth + HMAC dispatcher for the files container.
 *
 * Loaded by nginx via `js_engine qjs; js_import filesAuth from files-auth.mjs;`
 * and wired into `location /files/` with `js_content filesAuth.dispatch`.
 *
 * The HMAC contract MUST match app/api/src/Http/Auth/UrlSigner.php byte-for-byte
 * — there are pest fixtures pinning the canonical input format and the base64url
 * encoding. If you change the format here, change UrlSigner.php and re-pin the
 * UrlSignerTest "cross-check" fixture.
 *
 * Dispatch:
 *   PUT / DELETE         → /_files_dav_with_auth/<key>   (auth_request → PHP, then DAV writes the bytes)
 *   GET / HEAD signed    → verify HMAC; then /_files_serve/<key>  (no PHP, no DB — even on range requests)
 *   GET / HEAD unsigned  → /_files_get_with_auth/<key>   (auth_request → PHP, legacy DB-backed flow)
 *
 * `$request_uri` stays at the client's original URI even after internalRedirect,
 * so the PHP /_auth callback still sees `/files/<key>?…`.
 */

import crypto from 'crypto';

const SIGNING_KEY = process.env.FILES_SIGNING_KEY;
const SESSION_COOKIE = 'paith_session';

// Exported so the Node-based cross-check test in files-auth.test.mjs can call
// the exact same canonical-input + HMAC + base64url path that the in-nginx
// dispatcher uses. Mirrors PHP UrlSigner::sign byte-for-byte.
export function sign(key, objectKey, exp, sessionId, filename, contentType, inline) {
    const canonical = [
        objectKey,
        String(exp),
        sessionId,
        filename,
        contentType,
        inline ? '1' : '0',
    ].join('\n');
    const h = crypto.createHmac('sha256', key);
    h.update(canonical);
    return base64UrlEncode(h.digest());
}

function base64UrlEncode(buf) {
    return buf.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

// Paith convention: files are stored on disk WITHOUT extension (e.g.
// /data/notes/<nook>/files/<note>/<attr>/v1) but URLs are allowed to carry
// an extension for content-type hints from the browser (.../<attr>/v1.png).
// The old nginx config used a `location ~ ^/files/(.+)\.[^/]+$` regex to
// strip it before `alias`; we do the same in qjs so the internal-redirect
// target (and HMAC objectKey) match what's actually on disk + in the DB.
function stripExt(path) {
    const lastSlash = path.lastIndexOf('/');
    const base = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dot = base.lastIndexOf('.');
    if (dot > 0) {
        return path.slice(0, path.length - (base.length - dot));
    }
    return path;
}

function parseCookie(header, name) {
    if (!header) return '';
    const parts = String(header).split(';');
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i].trim();
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        if (p.slice(0, eq) === name) {
            return p.slice(eq + 1);
        }
    }
    return '';
}

function contentDisposition(filename, inline) {
    const type = inline ? 'inline' : 'attachment';
    const ascii = (filename || 'download').replace(/[\\\/\x00-\x1F\x7F"']/g, '') || 'download';
    const encoded = encodeURIComponent(filename || 'download');
    return type + '; filename="' + ascii + '"; filename*=UTF-8\'\'' + encoded;
}

function dispatch(r) {
    // Strip an optional URL extension (.../<attr>.png → .../<attr>) before
    // anything else: it's a content-type hint for the browser, not part of
    // the on-disk object key or the HMAC canonical input.
    const strippedPath = stripExt(r.uri).slice('/files'.length);

    // PUT / DELETE — PHP claims the single-use temp upload via auth_request,
    // then nginx's DAV module writes the bytes directly to disk. Skip qjs/HMAC.
    if (r.method === 'PUT' || r.method === 'DELETE') {
        r.internalRedirect('/_files_dav_with_auth' + strippedPath);
        return;
    }

    if (r.method !== 'GET' && r.method !== 'HEAD') {
        r.return(405);
        return;
    }

    // Unsigned URL → legacy DB-backed forward-auth flow (used by inline image
    // embeds in rendered markdown, where the URL is stable and revocation is
    // immediate).
    const sig = r.args.sig;
    const expRaw = r.args.exp;
    if (!sig || !expRaw) {
        r.internalRedirect('/_files_get_with_auth' + strippedPath);
        return;
    }

    if (!SIGNING_KEY) {
        // The entrypoint hard-fails on missing key, so this should never fire
        // in production. Belt and suspenders.
        r.error('FILES_SIGNING_KEY is not set; refusing to verify signed URL');
        r.return(500);
        return;
    }

    const exp = parseInt(expRaw, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!exp || exp <= nowSec) {
        r.return(401);
        return;
    }

    const objectKey = decodeURIComponent(strippedPath.replace(/^\//, ''));
    const sessionId = parseCookie(r.headersIn.Cookie, SESSION_COOKIE);
    const filename    = r.args.fn ? decodeURIComponent(r.args.fn) : '';
    const contentType = r.args.ct ? decodeURIComponent(r.args.ct) : '';
    const inline = r.args.inline === '1';

    const expected = sign(SIGNING_KEY, objectKey, exp, sessionId, filename, contentType, inline);
    if (!constantTimeEqual(expected, sig)) {
        r.return(401);
        return;
    }

    // Verified — set the headers the static handler will emit, then redirect
    // to the no-auth serve location. Browser range requests for media reuse
    // the same signature; each one runs through this function again (cheap)
    // and lands on the same internalRedirect path.
    r.headersOut['Content-Type'] = contentType || 'application/octet-stream';
    r.headersOut['Content-Disposition'] = contentDisposition(filename, inline);

    // The URL itself is the cache key — sig+exp make it unique per session,
    // so private caching is safe. max-age aligns with sig validity so the
    // browser naturally re-asks the API for a fresh URL on expiry.
    const remaining = exp - nowSec;
    r.headersOut['Cache-Control'] = 'private, max-age=' + remaining;

    r.internalRedirect('/_files_serve' + strippedPath);
}

export default { dispatch };
