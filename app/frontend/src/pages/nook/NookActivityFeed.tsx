import { A } from "@solidjs/router";
import { createSignal, For, Show, onMount } from "solid-js";
import { ActorLabel } from "../../components/ActorLabel";
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

	const formatDate = (iso: string) => {
		try {
			const d = new Date(iso);
			return d.toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			});
		} catch {
			return iso;
		}
	};

	const actionLabel = (action: string) => {
		if (action === "INSERT") return "created";
		if (action === "UPDATE") return "edited";
		if (action === "DELETE") return "deleted";
		return action.toLowerCase();
	};

	const tableLabel = (name: string) => {
		const map: Record<string, string> = {
			notes: "note",
			note_types: "type",
			note_links: "link",
			link_predicates: "predicate",
			nooks: "nook",
			note_files: "file",
			nook_invitations: "invitation",
			nook_members: "member",
		};
		return map[name] || name;
	};

	const noteLink = (entry: ActivityEntry) => {
		if (entry.table_name === "notes" && entry.nook_id && entry.table_id) {
			return `/nooks/${encodeURIComponent(entry.nook_id)}/notes/${encodeURIComponent(entry.table_id)}`;
		}
		return null;
	};

	return (
		<>
			<notePreview.PreviewPopover />
			<div style={{ padding: "1.5rem", "max-width": "600px" }}>
				<div style={{ display: "flex", "align-items": "center", "justify-content": "space-between", "margin-bottom": "1rem" }}>
					<h3 style={{ margin: "0", "font-size": "1.1rem" }}>Activity</h3>
					<Button variant="secondary" size="small" onClick={props.onClose}>
						Close
					</Button>
				</div>

				<div>
					<For each={activity()}>
						{(entry) => (
							<div style={{
								padding: "6px 0",
								"border-bottom": "1px solid var(--border-color, #eee)",
								"font-size": "0.85rem",
								display: "flex",
								"align-items": "baseline",
								gap: "6px",
								"flex-wrap": "wrap",
							}}>
								<span style={{ "font-weight": "500", color: "var(--text-muted, #666)" }}>
									<ActorLabel actor={entry.actor} userName={entry.user_name} />
								</span>
								<span>{actionLabel(entry.action)}</span>
								{(() => {
									const link = noteLink(entry);
									if (link) {
										return (
											<A
												href={link}
												style={{ color: "var(--link-color, #0066cc)", "text-decoration": "none" }}
												onMouseEnter={(e) => {
													const rect = e.currentTarget.getBoundingClientRect();
													notePreview.show(entry.table_id, rect.left, rect.bottom, {
														nookId: entry.nook_id,
													});
												}}
												onMouseLeave={() => notePreview.hide()}
											>
												{entry.note_title || tableLabel(entry.table_name)}
											</A>
										);
									}
									return <span>{tableLabel(entry.table_name)}</span>;
								})()}
								<span style={{ color: "var(--text-muted, #aaa)", "font-size": "0.75rem" }}>
									v{entry.version} &middot; {formatDate(entry.created_at)}
								</span>
							</div>
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
