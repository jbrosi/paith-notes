import type { WebSocket } from "ws";

export interface ConnMeta {
	userId: string;
	userName: string;
	nookId: string;
	viewingNoteId: string;
}

export interface Hub {
	addClient(ws: WebSocket, meta: ConnMeta): void;
	removeClient(ws: WebSocket): void;
	getMeta(ws: WebSocket): ConnMeta | undefined;
	send(ws: WebSocket, data: Record<string, unknown>): void;
	broadcastToNook(nookId: string, data: Record<string, unknown>): void;
	getViewers(
		nookId: string,
		noteId: string,
	): Array<{ user_id: string; user_name: string }>;
	broadcastPresence(nookId: string, noteId: string): void;
	handleMessage(ws: WebSocket, raw: string): void;
	handlePgNotification(payload: string): void;
	nookClientCount(nookId: string): number;
}

export function createHub(): Hub {
	const nookClients = new Map<string, Set<WebSocket>>();
	const connMeta = new WeakMap<WebSocket, ConnMeta>();

	const hub: Hub = {
		addClient(ws, meta) {
			connMeta.set(ws, meta);
			let set = nookClients.get(meta.nookId);
			if (!set) {
				set = new Set();
				nookClients.set(meta.nookId, set);
			}
			set.add(ws);
		},

		removeClient(ws) {
			const meta = connMeta.get(ws);
			if (!meta) return;
			const set = nookClients.get(meta.nookId);
			if (set) {
				set.delete(ws);
				if (set.size === 0) nookClients.delete(meta.nookId);
			}
			if (meta.viewingNoteId) {
				hub.broadcastPresence(meta.nookId, meta.viewingNoteId);
			}
		},

		getMeta(ws) {
			return connMeta.get(ws);
		},

		send(ws, data) {
			if (ws.readyState === ws.OPEN) {
				ws.send(JSON.stringify(data));
			}
		},

		broadcastToNook(nookId, data) {
			const set = nookClients.get(nookId);
			if (!set) return;
			const msg = JSON.stringify(data);
			for (const ws of set) {
				if (ws.readyState === ws.OPEN) ws.send(msg);
			}
		},

		getViewers(nookId, noteId) {
			const set = nookClients.get(nookId);
			if (!set) return [];
			const viewers: Array<{ user_id: string; user_name: string }> = [];
			const seen = new Set<string>();
			for (const ws of set) {
				const m = connMeta.get(ws);
				if (m && m.viewingNoteId === noteId && !seen.has(m.userId)) {
					seen.add(m.userId);
					viewers.push({ user_id: m.userId, user_name: m.userName });
				}
			}
			return viewers;
		},

		broadcastPresence(nookId, noteId) {
			const viewers = hub.getViewers(nookId, noteId);
			hub.broadcastToNook(nookId, {
				type: "presence",
				note_id: noteId,
				viewers,
			});
		},

		handleMessage(ws, raw) {
			const meta = connMeta.get(ws);
			if (!meta) return;
			try {
				const msg = JSON.parse(raw) as Record<string, unknown>;
				if (msg.type === "viewing") {
					const prevNoteId = meta.viewingNoteId;
					meta.viewingNoteId = String(msg.note_id ?? "");
					if (prevNoteId && prevNoteId !== meta.viewingNoteId) {
						hub.broadcastPresence(meta.nookId, prevNoteId);
					}
					if (meta.viewingNoteId) {
						hub.broadcastPresence(meta.nookId, meta.viewingNoteId);
					}
				}
			} catch {
				// ignore malformed
			}
		},

		handlePgNotification(payload) {
			try {
				const data = JSON.parse(payload) as Record<string, unknown>;
				const nookId = String(data.nook_id ?? "");
				if (!nookId) return;
				hub.broadcastToNook(nookId, {
					type: String(data.event ?? "unknown"),
					...data,
				});
			} catch {
				// malformed
			}
		},

		nookClientCount(nookId) {
			return nookClients.get(nookId)?.size ?? 0;
		},
	};

	return hub;
}
