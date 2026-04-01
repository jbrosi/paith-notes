import { createEffect, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import styles from "./NookDashboard.module.css";
import type { NookStore } from "./store";

type NookStats = {
	total_notes: number;
	total_types: number;
	total_links: number;
	total_mentions: number;
	total_conversations: number;
	notes_per_type: Array<{ label: string; count: string }>;
	recently_edited: Array<{ id: string; title: string; updated_at: string }>;
	most_linked: Array<{ id: string; title: string; link_count: string }>;
	most_mentioned: Array<{ id: string; title: string; mention_count: string }>;
};

export type NookDashboardProps = {
	store: NookStore;
};

export function NookDashboard(props: NookDashboardProps) {
	const [stats, setStats] = createSignal<NookStats | null>(null);
	const [loading, setLoading] = createSignal(false);

	const nookId = () => props.store.nookId();

	createEffect(() => {
		const id = nookId();
		if (!id) return;
		setLoading(true);
		void (async () => {
			try {
				const res = await apiFetch(`/api/nooks/${id}/stats`, {
					method: "GET",
				});
				if (!res.ok) return;
				const body = (await res.json()) as { stats?: NookStats };
				if (body.stats) setStats(body.stats);
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
				<h2 class={styles.title}>Welcome to your nook</h2>
				<p class={styles.subtitle}>
					Search for a note above or create a new one to get started.
				</p>
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
								<div class={styles.statValue}>{s().total_conversations}</div>
								<div class={styles.statLabel}>Chats</div>
							</div>
						</div>

						<div class={styles.columns}>
							<Show when={s().recently_edited.length > 0}>
								<div class={styles.column}>
									<div class={styles.columnTitle}>Recently edited</div>
									<For each={s().recently_edited}>
										{(note) => (
											<button
												type="button"
												class={styles.noteItem}
												onClick={() => openNote(note.id)}
											>
												<span class={styles.noteTitle}>
													{note.title || "(untitled)"}
												</span>
												<span class={styles.noteMeta}>
													{formatDate(note.updated_at)}
												</span>
											</button>
										)}
									</For>
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

							<Show when={s().most_mentioned.length > 0}>
								<div class={styles.column}>
									<div class={styles.columnTitle}>Most mentioned</div>
									<For each={s().most_mentioned}>
										{(note) => (
											<button
												type="button"
												class={styles.noteItem}
												onClick={() => openNote(note.id)}
											>
												<span class={styles.noteTitle}>
													{note.title || "(untitled)"}
												</span>
												<span class={styles.noteBadge}>
													{note.mention_count}
												</span>
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

			<Show when={!loading() && stats()?.total_notes === 0}>
				<div class={styles.emptyAction}>
					<Button onClick={props.store.newNote}>Create your first note</Button>
				</div>
			</Show>
		</div>
	);
}
