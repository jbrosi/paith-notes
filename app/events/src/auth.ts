import { createDecipheriv } from "node:crypto";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type pg from "pg";

const COOKIE_NAME = "paith_session";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "";
const KEYCLOAK_ENABLED = process.env.KEYCLOAK_ENABLED === "1";
const KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL ?? "";
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? "master";

interface AuthUser {
	userId: string;
	userName: string;
}

function displayName(row: Record<string, unknown>): string {
	const nickname = String(row.nickname ?? "").trim();
	if (nickname) return nickname;
	const first = String(row.first_name ?? "").trim();
	const last = String(row.last_name ?? "").trim();
	return `${first} ${last}`.trim();
}

// ── Cookie parsing ──────────────────────────────────────────────────────────

function parseCookies(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const key = part.slice(0, eq).trim();
		const val = part.slice(eq + 1).trim();
		out[key] = val;
	}
	return out;
}

// ── Session decryption (matches PHP SessionCrypto: AES-256-GCM) ─────────────

function decryptSession(encoded: string): string {
	if (!SESSION_SECRET) throw new Error("SESSION_SECRET not set");
	const key = createHash("sha256").update(SESSION_SECRET).digest();
	const raw = Buffer.from(encoded, "base64");
	if (raw.length < 29) throw new Error("invalid encrypted payload");

	const iv = raw.subarray(0, 12);
	const tag = raw.subarray(12, 28);
	const ciphertext = raw.subarray(28);

	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	const decrypted = Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]);
	return decrypted.toString("utf8");
}

// ── Keycloak JWT verification ───────────────────────────────────────────────

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let issuer: string | null = null;

function getJwks() {
	if (!jwks) {
		issuer = `${KEYCLOAK_BASE_URL}/realms/${KEYCLOAK_REALM}`;
		jwks = createRemoteJWKSet(
			new URL(`${issuer}/protocol/openid-connect/certs`),
		);
	}
	return { jwks, issuer: issuer! };
}

// ── Main auth function ──────────────────────────────────────────────────────

export async function authenticate(
	req: IncomingMessage,
	pool: pg.Pool,
): Promise<AuthUser | null> {
	// Dev mode: trust X-Nook-User header or dev_user query param
	if (!KEYCLOAK_ENABLED) {
		const url = new URL(req.url ?? "", `http://${req.headers.host}`);
		const userId =
			(req.headers["x-nook-user"] as string)?.trim() ||
			url.searchParams.get("dev_user")?.trim() ||
			"";
		if (!userId) return null;
		// Look up user name from DB
		try {
			const res = await pool.query(
				"SELECT id, first_name, last_name, nickname FROM global.users WHERE id = $1",
				[userId],
			);
			const row = res.rows[0];
			return row
				? { userId: String(row.id), userName: displayName(row) }
				: { userId, userName: "dev" };
		} catch {
			return { userId, userName: "dev" };
		}
	}

	// Production: session cookie → DB → decrypt → JWT verify
	const cookieHeader = req.headers.cookie ?? "";
	if (!cookieHeader) return null;

	const cookies = parseCookies(cookieHeader);
	const sessionId = cookies[COOKIE_NAME]?.trim();
	if (!sessionId) return null;

	try {
		// Look up session in DB
		const res = await pool.query(
			"SELECT user_id, token_encrypted FROM global.sessions WHERE id = $1 AND expires_at > now()",
			[sessionId],
		);
		const row = res.rows[0];
		if (!row) return null;

		const userId = String(row.user_id);
		const tokenEncrypted = String(row.token_encrypted);

		// Decrypt the session payload
		const payloadJson = decryptSession(tokenEncrypted);
		const payload = JSON.parse(payloadJson) as Record<string, unknown>;
		const accessToken = String(payload.access_token ?? "").trim();
		if (!accessToken) return null;

		// Verify JWT
		const { jwks: keys, issuer: iss } = getJwks();
		await jwtVerify(accessToken, keys, { issuer: iss });

		// Get user name
		const userRes = await pool.query(
			"SELECT first_name, last_name, nickname FROM global.users WHERE id = $1",
			[userId],
		);
		const userName = userRes.rows[0] ? displayName(userRes.rows[0]) : "";

		return { userId, userName };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Don't log expected auth failures (expired tokens etc)
		if (!msg.includes("expired") && !msg.includes("session not found")) {
			console.error("auth error:", msg);
		}
		return null;
	}
}
