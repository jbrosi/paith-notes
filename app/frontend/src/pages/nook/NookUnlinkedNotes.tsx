import { createSignal, For, onMount, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import { createNotePreview } from "../../components/NotePreview";
import type { NookStore } from "./store";

type UnlinkedNote = {
	id: string;
	title: string;
	type: string;
	type_id: string;
	created_at: string;
	updated_at: string;
};

type Props = {
	nookId: string;
	store: NookStore;
	onClose: () => void;
};

export function NookUnlinkedNotes(props: Props) {
	const notePreview = createNotePreview(() => props.nookId);
	const [notes, setNotes] = createSignal<UnlinkedNote[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [hasMore, setHasMore] = createSignal(true);
	const [offset, setOffset] = createSignal(0);

	const loadMore = async () => {
		if (loading()) return;
		setLoading(true);
		try {
			const params = new URLSearchParams({
				limit: "30",
				offset: String(offset()),
			});
			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/unlinked-notes?${params}`,
				{ method: "GET" },
			);
			if (!res.ok) return;
			const body = (await res.json()) as { notes?: UnlinkedNote[] };
			const list = body?.notes ?? [];
			setNotes((prev) => [...prev, ...list]);
			setOffset((prev) => prev + list.length);
			if (list.length < 30) setHasMore(false);
		} catch {
			// best-effort
		} finally {
			setLoading(false);
		}
	};

	onMount(() => {
		void loadMore();
	});

	const openNote = (noteId: string) => {
		void props.store.onNoteLinkClick(noteId);
	};

	const formatDate = (iso: string) => {
		try {
			const d = new Date(iso);
			const now = new Date();
			const diffMs = now.getTime() - d.getTime();
			const diffMin = Math.floor(diffMs / 60000);
			if (diffMin < 1) return "just now";
			if (diffMin < 60) return `${diffMin}m ago`;
			const diffH = Math.floor(diffMin / 60);
			if (diffH < 24) return `${diffH}h ago`;
			const diffD = Math.floor(diffH / 24);
			if (diffD < 7) return `${diffD}d ago`;
			return d.toLocaleDateString();
		} catch {
			return iso;
		}
	};

	return (
		<>
			<notePreview.PreviewPopover />
			<div style={{ padding: "1.5rem", "max-width": "600px" }}>
				<div
					style={{
						display: "flex",
						"align-items": "center",
						"justify-content": "space-between",
						"margin-bottom": "1rem",
					}}
				>
					<h3 style={{ margin: "0", "font-size": "1.1rem" }}>Unlinked Notes</h3>
					<Button variant="secondary" size="small" onClick={props.onClose}>
						Close
					</Button>
				</div>
				<p
					style={{
						"font-size": "0.8rem",
						color: "var(--text-muted, #888)",
						"margin-bottom": "1rem",
					}}
				>
					Notes with no links or mentions (incoming or outgoing). Consider
					linking them to other notes or cleaning them up.
				</p>

				<div>
					<For each={notes()}>
						{(note) => (
							<button
								type="button"
								style={{
									display: "flex",
									"align-items": "center",
									"justify-content": "space-between",
									width: "100%",
									padding: "8px 0",
									"border-bottom": "1px solid var(--border-color, #eee)",
									background: "none",
									border: "none",
									"border-bottom-style": "solid",
									"border-bottom-width": "1px",
									"border-bottom-color": "var(--border-color, #eee)",
									cursor: "pointer",
									"text-align": "left",
									color: "inherit",
									"font-size": "0.85rem",
								}}
								onClick={() => openNote(note.id)}
								onMouseEnter={(e) => {
									const rect = e.currentTarget.getBoundingClientRect();
									notePreview.show(note.id, rect.left, rect.bottom, {
										onOpen: (id) => openNote(id),
									});
								}}
								onMouseLeave={() => notePreview.hide()}
							>
								<span style={{ "font-weight": "500" }}>
									{note.title || "(untitled)"}
								</span>
								<span
									style={{
										color: "var(--text-muted, #aaa)",
										"font-size": "0.75rem",
										"flex-shrink": "0",
										"margin-left": "8px",
									}}
								>
									{formatDate(note.updated_at)}
								</span>
							</button>
						)}
					</For>
				</div>

				<Show when={hasMore() && !loading()}>
					<button
						type="button"
						onClick={() => void loadMore()}
						style={{
							"margin-top": "1rem",
							padding: "8px 16px",
							cursor: "pointer",
							border: "1px solid var(--border-color, #ccc)",
							"border-radius": "4px",
							background: "none",
							color: "inherit",
						}}
					>
						Load more
					</button>
				</Show>
				<Show when={loading()}>
					<div
						style={{ "margin-top": "1rem", color: "var(--text-muted, #888)" }}
					>
						Loading...
					</div>
				</Show>
				<Show when={!loading() && notes().length === 0}>
					<div style={{ color: "var(--text-muted, #888)" }}>
						All notes are linked — nice!
					</div>
				</Show>
			</div>
		</>
	);
}
