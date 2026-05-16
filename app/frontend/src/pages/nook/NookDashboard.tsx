import { A } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { ActorLabel } from "../../components/ActorLabel";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import { NookNotesSearchDropdown } from "../../components/nav/NookNotesSearchDropdown";
import { NookTypeFilterDropdown } from "../../components/nav/NookTypeFilterDropdown";
import { useNotePreview } from "./NookContext";
import styles from "./NookDashboard.module.css";
import type { NookStore } from "./store";

type NookStats = {
	total_notes: number;
	total_types: number;
	total_links: number;
	total_mentions: number;
	total_file_size: number;
	unlinked_notes: number;
	notes_per_type: Array<{ label: string; count: string }>;
	recently_edited: Array<{ id: string; title: string; updated_at: string }>;
	most_linked: Array<{ id: string; title: string; link_count: string }>;
};

const TIPS = [
	'Use "type: person" in search to filter by note type.',
	"Type @ in the editor to mention and link to another note.",
	"Use !! in the editor to embed an image from another note.",
	"You can drag nodes in the graph view to rearrange them.",
	"Press Ctrl+S (or Cmd+S) to quickly save while editing.",
	"Notes by type breakdown shows how your nook is organized.",
];

export type NookDashboardProps = {
	store: NookStore;
	onNewNote?: () => void;
	onUploadFile?: () => void;
	onSettings?: () => void;
};

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

export function NookDashboard(props: NookDashboardProps) {
	const notePreview = useNotePreview();
	const [stats, setStats] = createSignal<NookStats | null>(null);
	const [loading, setLoading] = createSignal(false);
	const [recentActivity, setRecentActivity] = createSignal<ActivityEntry[]>([]);

	const nookId = () => props.store.nookId();

	const tip = createMemo(() => TIPS[Math.floor(Math.random() * TIPS.length)]);

	createEffect(() => {
		const id = nookId();
		if (!id) return;
		setLoading(true);
		void (async () => {
			try {
				const [statsRes, actRes] = await Promise.all([
					apiFetch(`/api/nooks/${id}/stats`, { method: "GET" }),
					apiFetch(`/api/nooks/${id}/activity?limit=7`, { method: "GET" }),
				]);
				if (statsRes.ok) {
					const body = (await statsRes.json()) as { stats?: NookStats };
					if (body.stats) setStats(body.stats);
				}
				if (actRes.ok) {
					const body = (await actRes.json()) as { activity?: ActivityEntry[] };
					setRecentActivity(body?.activity ?? []);
				}
			} catch {
				// best-effort
			} finally {
				setLoading(false);
			}
		})();
	});

	const openNote = (noteId: string) => {
		void props.store.onNoteLinkClick(noteId);
	};

	const formatBytes = (bytes: number) => {
		if (bytes === 0) return "0 B";
		const units = ["B", "KB", "MB", "GB"];
		const i = Math.min(
			Math.floor(Math.log(bytes) / Math.log(1024)),
			units.length - 1,
		);
		const value = bytes / 1024 ** i;
		return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
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
		<div class={styles.container}>
			<div class={styles.welcome}>
				<h2 class={styles.title}>{props.store.nookName() || "Your nook"}</h2>
				<p class={styles.subtitle}>
					Your dashboard — search, create, or pick up where you left off.
				</p>
			</div>

			{/* Action buttons — always visible */}
			<div class={styles.actions}>
				<Show when={props.store.canWrite()}>
					<Button
						variant="primary"
						size="small"
						onClick={() => (props.onNewNote ?? props.store.newNote)()}
					>
						+ New note
					</Button>
					<Show when={props.onUploadFile}>
						<Button
							variant="secondary"
							size="small"
							onClick={() => props.onUploadFile?.()}
						>
							Upload file
						</Button>
					</Show>
				</Show>
				<Show when={props.onSettings}>
					<Button
						variant="secondary"
						size="small"
						onClick={() => props.onSettings?.()}
					>
						Settings
					</Button>
				</Show>
			</div>

			{/* Search — same components as the nav bar */}
			<div class={styles.searchWrap}>
				<NookNotesSearchDropdown
					store={props.store}
					onNewNote={() => (props.onNewNote ?? props.store.newNote)()}
					onUploadFile={() => props.onUploadFile?.()}
				/>
				<NookTypeFilterDropdown store={props.store} />
			</div>

			<Show when={loading()}>
				<div class={styles.loading}>Loading stats...</div>
			</Show>

			<Show when={stats()}>
				{(s) => (
					<>
						<div class={styles.stats}>
							<div class={styles.statCard}>
								<div class={styles.statValue}>{s().total_notes}</div>
								<div class={styles.statLabel}>Notes</div>
							</div>
							<div class={styles.statCard}>
								<div class={styles.statValue}>{s().total_types}</div>
								<div class={styles.statLabel}>Types</div>
							</div>
							<div class={styles.statCard}>
								<div class={styles.statValue}>{s().total_links}</div>
								<div class={styles.statLabel}>Links</div>
							</div>
							<div class={styles.statCard}>
								<div class={styles.statValue}>{s().total_mentions}</div>
								<div class={styles.statLabel}>Mentions</div>
							</div>
							<div class={styles.statCard}>
								<div class={styles.statValue}>
									{formatBytes(s().total_file_size)}
								</div>
								<div class={styles.statLabel}>Files</div>
							</div>
							<Show when={s().unlinked_notes > 0}>
								<A
									href={`/nooks/${encodeURIComponent(nookId())}/settings/unlinked`}
									class={styles.statCard}
									style={{ "text-decoration": "none", color: "inherit" }}
								>
									<div class={styles.statValue} style={{ color: "var(--color-warning, #f59e0b)" }}>
										{s().unlinked_notes}
									</div>
									<div class={styles.statLabel}>Unlinked</div>
								</A>
							</Show>
						</div>

						<div class={styles.columns}>
							<Show when={recentActivity().length > 0}>
								<div class={styles.column}>
									<div class={styles.columnTitle}>Recent activity</div>
									<For each={recentActivity()}>
										{(entry) => {
											const actionLabel = entry.action === "INSERT" ? "created" : entry.action === "UPDATE" ? "edited" : entry.action === "DELETE" ? "deleted" : entry.action.toLowerCase();
											const isNote = entry.table_name === "notes" && entry.table_id;
											return (
												<div class={styles.noteItem} style={{ cursor: isNote ? "pointer" : "default" }}>
													<span
														class={styles.noteTitle}
														style={{ display: "flex", gap: "4px", "align-items": "baseline" }}
														onClick={() => isNote && openNote(entry.table_id)}
														onMouseEnter={(e) => {
															if (!isNote || !notePreview) return;
															const rect = e.currentTarget.getBoundingClientRect();
															notePreview.show(entry.table_id, rect.left, rect.bottom, {
																onOpen: (id) => openNote(id),
															});
														}}
														onMouseLeave={() => notePreview?.hide()}
													>
														<span style={{ "font-size": "0.75rem" }}>
														<ActorLabel actor={entry.actor} userName={entry.user_name} />
													</span>{" "}
														<span style={{ "font-size": "0.8rem" }}>
															{actionLabel}{" "}
															{isNote ? (entry.note_title || "note") : entry.table_name.replace("_", " ")}
														</span>
													</span>
													<span class={styles.noteMeta}>
														{formatDate(entry.created_at)}
													</span>
												</div>
											);
										}}
									</For>
									<A
										href={`/nooks/${encodeURIComponent(nookId())}/settings/activity`}
										style={{ "font-size": "0.75rem", "margin-top": "6px", display: "inline-block", color: "var(--link-color, #0066cc)", "text-decoration": "none" }}
									>
										View all activity
									</A>
								</div>
							</Show>

							<Show when={s().most_linked.length > 0}>
								<div class={styles.column}>
									<div class={styles.columnTitle}>Most linked</div>
									<For each={s().most_linked}>
										{(note) => (
											<button
												type="button"
												class={styles.noteItem}
												onClick={() => openNote(note.id)}
												onMouseEnter={(e) => {
													if (!notePreview) return;
													const rect = e.currentTarget.getBoundingClientRect();
													notePreview.show(note.id, rect.left, rect.bottom, {
														onOpen: (id) => openNote(id),
													});
												}}
												onMouseLeave={() => notePreview?.hide()}
											>
												<span class={styles.noteTitle}>
													{note.title || "(untitled)"}
												</span>
												<span class={styles.noteBadge}>{note.link_count}</span>
											</button>
										)}
									</For>
								</div>
							</Show>
						</div>

						<Show when={s().notes_per_type.length > 0}>
							<div class={styles.typeBreakdown}>
								<div class={styles.columnTitle}>Notes by type</div>
								<div class={styles.typeList}>
									<For each={s().notes_per_type}>
										{(t) => (
											<div class={styles.typeRow}>
												<span class={styles.typeLabel}>{t.label}</span>
												<div class={styles.typeBar}>
													<div
														class={styles.typeBarFill}
														style={{
															width: `${Math.max(4, (Number(t.count) / s().total_notes) * 100)}%`,
														}}
													/>
												</div>
												<span class={styles.typeCount}>{t.count}</span>
											</div>
										)}
									</For>
								</div>
							</div>
						</Show>
					</>
				)}
			</Show>

			{/* Tip */}
			<div class={styles.tip}>
				<span class={styles.tipLabel}>Tip:</span> {tip()}
			</div>
		</div>
	);
}
