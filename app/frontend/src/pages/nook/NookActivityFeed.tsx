import { createSignal, For, Show, onMount } from "solid-js";
import { ActivityEntryRow, type ActivityEntryData } from "../../components/ActivityEntryRow";
import { apiFetch } from "../../auth/keycloak";
import { createNotePreview } from "../../components/NotePreview";
import { Button } from "../../components/Button";

type ActivityEntry = {
	id: number;
	version: number;
	action: string;
	actor: string;
	table_name: string;
	table_id: string;
	nook_id: string;
	user_id: string;
	user_name: string;
	note_title?: string;
	link_source_id?: string;
	link_target_id?: string;
	link_source_title?: string;
	link_target_title?: string;
	link_forward_label?: string;
	created_at: string;
};

type Props = {
	nookId: string;
	onClose: () => void;
};

export function NookActivityFeed(props: Props) {
	const notePreview = createNotePreview(() => props.nookId);
	const [activity, setActivity] = createSignal<ActivityEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [hasMore, setHasMore] = createSignal(true);
	const [cursor, setCursor] = createSignal(0);

	const loadMore = async () => {
		if (loading()) return;
		setLoading(true);
		try {
			const params = new URLSearchParams({ limit: "30" });
			if (cursor() > 0) params.set("before", String(cursor()));

			const res = await apiFetch(
				`/api/nooks/${encodeURIComponent(props.nookId)}/activity?${params}`,
				{ method: "GET" },
			);
			if (!res.ok) return;
			const body = (await res.json()) as { activity?: ActivityEntry[] };
			const list = body?.activity ?? [];
			setActivity((prev) => [...prev, ...list]);
			if (list.length > 0) setCursor(list[list.length - 1].id);
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

	const tableLabel = (name: string) => {
		const map: Record<string, string> = {
			notes: "note",
			note_types: "type",
			note_links: "link",
			note_cross_links: "cross-link",
			link_predicates: "predicate",
			nooks: "nook",
			note_files: "file",
			nook_invitations: "invitation",
			nook_members: "member",
		};
		return map[name] || name;
	};

	const toEntryData = (entry: ActivityEntry): ActivityEntryData => {
		const isNote = entry.table_name === "notes";
		const isLink = entry.table_name === "note_links" || entry.table_name === "note_cross_links";
		if (isLink) {
			return {
				actor: entry.actor,
				userName: entry.user_name,
				action: entry.action,
				type: "link",
				linkLabel: entry.link_forward_label || "→",
				linkSourceTitle: entry.link_source_title || "?",
				linkSourceId: entry.link_source_id,
				linkTargetTitle: entry.link_target_title || "?",
				linkTargetId: entry.link_target_id,
				createdAt: entry.created_at,
			};
		}
		return {
			actor: entry.actor,
			userName: entry.user_name,
			action: entry.action,
			type: isNote ? "note" : tableLabel(entry.table_name),
			linkedNoteTitle: isNote ? (entry.note_title || undefined) : undefined,
			linkedNoteId: isNote ? entry.table_id : undefined,
			version: isNote ? entry.version : undefined,
			createdAt: entry.created_at,
		};
	};

	const handleNoteHover = (noteId: string, x: number, y: number) => {
		notePreview.show(noteId, x, y, { nookId: props.nookId });
	};

	return (
		<>
			<notePreview.PreviewPopover />
			<div style={{ padding: "1.5rem", "max-width": "600px" }}>
				<div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "0.5rem" }}>
					<h3 style={{ margin: "0", "font-size": "1.1rem" }}>Nook Activity</h3>
					<Button variant="secondary" size="small" onClick={props.onClose}>
						Back to dashboard
					</Button>
				</div>

				<div>
					<For each={activity()}>
						{(entry) => (
							<ActivityEntryRow
								entry={toEntryData(entry)}
								buildNoteHref={(noteId) =>
									`/nooks/${encodeURIComponent(props.nookId)}/notes/${encodeURIComponent(noteId)}`
								}
								onNoteHover={handleNoteHover}
								onNoteLeave={() => notePreview.hide()}
							/>
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
					<div style={{ "margin-top": "1rem", color: "var(--text-muted, #888)" }}>Loading...</div>
				</Show>
				<Show when={!loading() && activity().length === 0}>
					<div style={{ color: "var(--text-muted, #888)" }}>No activity yet</div>
				</Show>
			</div>
		</>
	);
}
