import { createServer } from "node:http";
import pg from "pg";
import { WebSocketServer } from "ws";
import { authenticate } from "./auth.js";
import { createHub } from "./hub.js";

// ── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.EVENTS_PORT || 3002);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

// ── Hub ─────────────────────────────────────────────────────────────────────

const hub = createHub();

// ── Postgres LISTEN ─────────────────────────────────────────────────────────

async function startPgListener() {
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	await client.query("LISTEN nook_events");

	client.on("notification", (msg) => {
		if (msg.channel !== "nook_events" || !msg.payload) return;
		hub.handlePgNotification(msg.payload);
	});

	client.on("error", (err) => {
		console.error("pg listener error:", err.message);
		setTimeout(() => void startPgListener(), 3000);
	});

	console.log("pg: listening on nook_events");
}

// ── Auth DB pool (for session lookups) ──────────────────────────────────────

const authPool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

// ── HTTP + WebSocket server ─────────────────────────────────────────────────

const server = createServer((req, res) => {
	if (req.url === "/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end('{"ok":true}');
		return;
	}
	res.writeHead(404);
	res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
	try {
		const url = new URL(req.url ?? "", `http://${req.headers.host}`);
		const match = url.pathname.match(/^\/ws\/nooks\/([^/]+)$/);
		if (!match) {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		const nookId = decodeURIComponent(match[1]);

		const user = await authenticate(req, authPool);
		if (!user) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}

		wss.handleUpgrade(req, socket, head, (ws) => {
			const meta = {
				userId: user.userId,
				userName: user.userName,
				nookId,
				viewingNoteId: "",
			};
			hub.addClient(ws, meta);

			ws.on("message", (raw) => hub.handleMessage(ws, String(raw)));
			ws.on("close", () => hub.removeClient(ws));
			ws.on("error", () => hub.removeClient(ws));

			hub.send(ws, {
				type: "connected",
				nook_id: nookId,
				user_id: user.userId,
				user_name: user.userName,
			});
		});
	} catch (err) {
		console.error("upgrade error:", err);
		socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
		socket.destroy();
	}
});

// ── Heartbeat ───────────────────────────────────────────────────────────────

setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.readyState === ws.OPEN) ws.ping();
	}
}, 30_000);

// ── Start ───────────────────────────────────────────────────────────────────

await startPgListener();
server.listen(PORT, () => {
	console.log(`events server listening on :${PORT}`);
});
