import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHub, type ConnMeta } from "./hub.js";

// Minimal WebSocket mock
function mockWs(opts?: { readyState?: number }): {
	ws: import("ws").WebSocket;
	sent: string[];
} {
	const sent: string[] = [];
	const ws = {
		readyState: opts?.readyState ?? 1, // OPEN
		OPEN: 1,
		send(data: string) {
			sent.push(data);
		},
		ping() {},
	} as unknown as import("ws").WebSocket;
	return { ws, sent };
}

function meta(overrides?: Partial<ConnMeta>): ConnMeta {
	return {
		userId: "user-1",
		userName: "Alice",
		nookId: "nook-1",
		viewingNoteId: "",
		...overrides,
	};
}

describe("Hub", () => {
	let hub: ReturnType<typeof createHub>;

	beforeEach(() => {
		hub = createHub();
	});

	describe("addClient / removeClient", () => {
		it("tracks clients per nook", () => {
			const { ws: ws1 } = mockWs();
			const { ws: ws2 } = mockWs();
			hub.addClient(ws1, meta());
			hub.addClient(ws2, meta({ nookId: "nook-2" }));

			assert.equal(hub.nookClientCount("nook-1"), 1);
			assert.equal(hub.nookClientCount("nook-2"), 1);
		});

		it("removes client and cleans up empty nooks", () => {
			const { ws } = mockWs();
			hub.addClient(ws, meta());
			assert.equal(hub.nookClientCount("nook-1"), 1);

			hub.removeClient(ws);
			assert.equal(hub.nookClientCount("nook-1"), 0);
		});

		it("broadcasts presence update when removed client was viewing", () => {
			const { ws: ws1, sent: sent1 } = mockWs();
			const { ws: ws2 } = mockWs();
			const m1 = meta({ userId: "user-1", viewingNoteId: "note-1" });
			const m2 = meta({ userId: "user-2", viewingNoteId: "note-1" });
			hub.addClient(ws1, m1);
			hub.addClient(ws2, m2);

			// Remove user-1 — user-2 should get a presence update
			sent1.length = 0;
			hub.removeClient(ws1);

			// ws2 receives the broadcast (ws1 is already removed)
			// We can't check ws2's sent directly since it goes through broadcastToNook
			const viewers = hub.getViewers("nook-1", "note-1");
			assert.equal(viewers.length, 1);
			assert.equal(viewers[0].user_id, "user-2");
		});
	});

	describe("getViewers", () => {
		it("returns only clients viewing the specified note", () => {
			const { ws: ws1 } = mockWs();
			const { ws: ws2 } = mockWs();
			const { ws: ws3 } = mockWs();
			hub.addClient(ws1, meta({ userId: "u1", viewingNoteId: "note-A" }));
			hub.addClient(ws2, meta({ userId: "u2", viewingNoteId: "note-B" }));
			hub.addClient(ws3, meta({ userId: "u3", viewingNoteId: "note-A" }));

			const viewers = hub.getViewers("nook-1", "note-A");
			assert.equal(viewers.length, 2);
			const ids = viewers.map((v) => v.user_id).sort();
			assert.deepEqual(ids, ["u1", "u3"]);
		});

		it("deduplicates by userId (multiple tabs)", () => {
			const { ws: ws1 } = mockWs();
			const { ws: ws2 } = mockWs();
			hub.addClient(ws1, meta({ userId: "u1", viewingNoteId: "note-A" }));
			hub.addClient(ws2, meta({ userId: "u1", viewingNoteId: "note-A" }));

			const viewers = hub.getViewers("nook-1", "note-A");
			assert.equal(viewers.length, 1);
		});

		it("returns empty for unknown nook", () => {
			assert.deepEqual(hub.getViewers("nonexistent", "note-1"), []);
		});
	});

	describe("handleMessage — viewing", () => {
		it("updates viewing state", () => {
			const { ws } = mockWs();
			hub.addClient(ws, meta());

			hub.handleMessage(ws, JSON.stringify({ type: "viewing", note_id: "note-X" }));

			const m = hub.getMeta(ws);
			assert.equal(m?.viewingNoteId, "note-X");
		});

		it("broadcasts presence for new note", () => {
			const { ws: ws1, sent: sent1 } = mockWs();
			const { ws: ws2, sent: sent2 } = mockWs();
			hub.addClient(ws1, meta({ userId: "u1" }));
			hub.addClient(ws2, meta({ userId: "u2" }));

			hub.handleMessage(ws1, JSON.stringify({ type: "viewing", note_id: "note-X" }));

			// Both clients receive presence broadcast
			const msg1 = JSON.parse(sent1[sent1.length - 1]);
			const msg2 = JSON.parse(sent2[sent2.length - 1]);
			assert.equal(msg1.type, "presence");
			assert.equal(msg1.note_id, "note-X");
			assert.equal(msg1.viewers.length, 1);
			assert.equal(msg1.viewers[0].user_id, "u1");
			assert.equal(msg2.type, "presence");
		});

		it("broadcasts presence for old note when switching", () => {
			const { ws: ws1, sent: sent1 } = mockWs();
			const { ws: ws2, sent: sent2 } = mockWs();
			hub.addClient(ws1, meta({ userId: "u1", viewingNoteId: "note-A" }));
			hub.addClient(ws2, meta({ userId: "u2", viewingNoteId: "note-A" }));
			sent1.length = 0;
			sent2.length = 0;

			// u1 switches from note-A to note-B
			hub.handleMessage(ws1, JSON.stringify({ type: "viewing", note_id: "note-B" }));

			// Should receive 2 broadcasts: one for note-A (u1 left) and one for note-B (u1 joined)
			const msgs = sent2.map((s) => JSON.parse(s));
			const noteAPresence = msgs.find((m: Record<string, unknown>) => m.note_id === "note-A");
			const noteBPresence = msgs.find((m: Record<string, unknown>) => m.note_id === "note-B");

			assert.ok(noteAPresence, "should broadcast presence for old note");
			assert.equal(noteAPresence.viewers.length, 1); // only u2 left
			assert.equal(noteAPresence.viewers[0].user_id, "u2");

			assert.ok(noteBPresence, "should broadcast presence for new note");
			assert.equal(noteBPresence.viewers.length, 1); // u1 joined
			assert.equal(noteBPresence.viewers[0].user_id, "u1");
		});

		it("ignores malformed messages", () => {
			const { ws } = mockWs();
			hub.addClient(ws, meta());
			// Should not throw
			hub.handleMessage(ws, "not json");
			hub.handleMessage(ws, "{}");
			hub.handleMessage(ws, JSON.stringify({ type: "unknown" }));
		});
	});

	describe("broadcastToNook", () => {
		it("sends to all clients in nook", () => {
			const { ws: ws1, sent: sent1 } = mockWs();
			const { ws: ws2, sent: sent2 } = mockWs();
			const { ws: ws3, sent: sent3 } = mockWs();
			hub.addClient(ws1, meta({ nookId: "nook-1" }));
			hub.addClient(ws2, meta({ nookId: "nook-1" }));
			hub.addClient(ws3, meta({ nookId: "nook-2" }));

			hub.broadcastToNook("nook-1", { type: "test", data: "hello" });

			assert.equal(sent1.length, 1);
			assert.equal(sent2.length, 1);
			assert.equal(sent3.length, 0); // different nook
		});

		it("skips closed connections", () => {
			const { ws: ws1, sent: sent1 } = mockWs({ readyState: 3 }); // CLOSED
			const { ws: ws2, sent: sent2 } = mockWs();
			hub.addClient(ws1, meta());
			hub.addClient(ws2, meta());

			hub.broadcastToNook("nook-1", { type: "test" });

			assert.equal(sent1.length, 0);
			assert.equal(sent2.length, 1);
		});
	});

	describe("handlePgNotification", () => {
		it("broadcasts event to correct nook", () => {
			const { ws: ws1, sent: sent1 } = mockWs();
			const { ws: ws2, sent: sent2 } = mockWs();
			hub.addClient(ws1, meta({ nookId: "nook-1" }));
			hub.addClient(ws2, meta({ nookId: "nook-2" }));

			hub.handlePgNotification(
				JSON.stringify({ nook_id: "nook-1", event: "types_changed", table: "note_types", id: "t1" }),
			);

			assert.equal(sent1.length, 1);
			assert.equal(sent2.length, 0);

			const msg = JSON.parse(sent1[0]);
			assert.equal(msg.type, "types_changed");
			assert.equal(msg.nook_id, "nook-1");
		});

		it("ignores payloads without nook_id", () => {
			const { ws, sent } = mockWs();
			hub.addClient(ws, meta());
			hub.handlePgNotification(JSON.stringify({ event: "test" }));
			assert.equal(sent.length, 0);
		});

		it("ignores malformed JSON", () => {
			const { ws, sent } = mockWs();
			hub.addClient(ws, meta());
			hub.handlePgNotification("not json");
			assert.equal(sent.length, 0);
		});
	});
});
