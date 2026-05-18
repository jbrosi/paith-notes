import { A, useNavigate } from "@solidjs/router";
import { createSignal, For, onMount, Show } from "solid-js";
import { apiFetch } from "../auth/keycloak";
import { ActorLabel } from "../components/ActorLabel";
import { createNotePreview } from "../components/NotePreview";

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

type EventEntry = {
	id: number;
	event: string;
	meta: Record<string, string>;
	created_at: string;
};

type Tab = "activity" | "sessions";

export default function MyActivity() {
	const navigate = useNavigate();
	const notePreview = createNotePreview(() => "");
	const [tab, setTab] = createSignal<Tab>("activity");

	// Activity stream
	const [activity, setActivity] = createSignal<ActivityEntry[]>([]);
	const [actLoading, setActLoading] = createSignal(false);
	const [actHasMore, setActHasMore] = createSignal(true);
	const [actCursor, setActCursor] = createSignal(0);

	// Events stream
	const [events, setEvents] = createSignal<EventEntry[]>([]);
	const [evtLoading, setEvtLoading] = createSignal(false);
	const [evtHasMore, setEvtHasMore] = createSignal(true);
	const [evtCursor, setEvtCursor] = createSignal(0);

	const loadActivity = async () => {
		if (actLoading()) return;
		setActLoading(true);
		try {
			const params = new URLSearchParams({ limit: "20" });
			if (actCursor() > 0) params.set("before", String(actCursor()));

			const res = await apiFetch(`/api/me/activity?${params}`, {
				method: "GET",
			});
			if (!res.ok) return;
			const body = (await res.json()) as { activity?: ActivityEntry[] };
			const list = body?.activity ?? [];
			setActivity((prev) => [...prev, ...list]);
			if (list.length > 0) setActCursor(list[list.length - 1].id);
			if (list.length < 20) setActHasMore(false);
		} catch {
			// best-effort
		} finally {
			setActLoading(false);
		}
	};

	const loadEvents = async () => {
		if (evtLoading()) return;
		setEvtLoading(true);
		try {
			const params = new URLSearchParams({ limit: "20" });
			if (evtCursor() > 0) params.set("before", String(evtCursor()));

			const res = await apiFetch(`/api/me/events?${params}`, { method: "GET" });
			if (!res.ok) return;
			const body = (await res.json()) as { events?: EventEntry[] };
			const list = body?.events ?? [];
			setEvents((prev) => [...prev, ...list]);
			if (list.length > 0) setEvtCursor(list[list.length - 1].id);
			if (list.length < 20) setEvtHasMore(false);
		} catch {
			// best-effort
		} finally {
			setEvtLoading(false);
		}
	};

	onMount(() => {
		void loadActivity();
		void loadEvents();
	});

	const formatDate = (iso: string) => {
		try {
			const d = new Date(iso);
			return d.toLocaleDateString(undefined, {
				day: "numeric",
				month: "short",
				year: "numeric",
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
			note_types: "note type",
			note_links: "link",
			link_predicates: "predicate",
			nooks: "nook",
			note_files: "file",
			nook_invitations: "invitation",
			users: "profile",
		};
		return map[name] || name;
	};

	const noteLink = (entry: ActivityEntry) => {
		if (entry.table_name === "notes" && entry.nook_id && entry.table_id) {
			return `/nooks/${encodeURIComponent(entry.nook_id)}/notes/${encodeURIComponent(entry.table_id)}`;
		}
		return null;
	};

	const tabStyle = (t: Tab) => ({
		padding: "6px 16px",
		border: "none",
		"border-bottom":
			tab() === t
				? "2px solid var(--link-color, #0066cc)"
				: "2px solid transparent",
		background: "none",
		cursor: "pointer",
		"font-weight": tab() === t ? "600" : "400",
		color: "inherit",
		"font-size": "0.9rem",
	});

	return (
		<>
			<notePreview.PreviewPopover />
			<div
				style={{ padding: "1.5rem", "max-width": "600px", margin: "0 auto" }}
			>
				<h2 style={{ "margin-bottom": "1rem", "font-size": "1.25rem" }}>
					My Activity
				</h2>

				<div
					style={{
						"border-bottom": "1px solid var(--border-color, #eee)",
						"margin-bottom": "1rem",
					}}
				>
					<button
						type="button"
						style={tabStyle("activity")}
						onClick={() => setTab("activity")}
					>
						Changes
					</button>
					<button
						type="button"
						style={tabStyle("sessions")}
						onClick={() => setTab("sessions")}
					>
						Sessions
					</button>
				</div>

				{/* Activity tab */}
				<Show when={tab() === "activity"}>
					<div>
						<For each={activity()}>
							{(entry) => (
								<div
									style={{
										padding: "8px 0",
										"border-bottom": "1px solid var(--border-color, #eee)",
										"font-size": "0.85rem",
									}}
								>
									<span style={{ "font-weight": "500" }}>
										<ActorLabel
											actor={entry.actor}
											userName={entry.user_name}
										/>
									</span>{" "}
									<span style={{ "font-weight": "500" }}>
										{actionLabel(entry.action)}
									</span>{" "}
									{(() => {
										const link = noteLink(entry);
										if (link) {
											return (
												<A
													href={link}
													style={{
														color: "var(--link-color, #0066cc)",
														"text-decoration": "none",
													}}
													onMouseEnter={(e) => {
														const rect =
															e.currentTarget.getBoundingClientRect();
														notePreview.show(
															entry.table_id,
															rect.left,
															rect.bottom,
															{
																nookId: entry.nook_id,
																onOpen: () => navigate(link),
															},
														);
													}}
													onMouseLeave={() => notePreview.hide()}
												>
													{entry.note_title || tableLabel(entry.table_name)}
												</A>
											);
										}
										return <span>{tableLabel(entry.table_name)}</span>;
									})()}
									<span
										style={{
											color: "var(--text-muted, #888)",
											"margin-left": "4px",
										}}
									>
										v{entry.version}
									</span>
									<span
										style={{
											color: "var(--text-muted, #888)",
											"margin-left": "8px",
											"font-size": "0.75rem",
										}}
									>
										{formatDate(entry.created_at)}
									</span>
								</div>
							)}
						</For>
					</div>
					<Show when={actHasMore() && !actLoading()}>
						<button
							type="button"
							onClick={() => void loadActivity()}
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
					<Show when={actLoading()}>
						<div
							style={{ "margin-top": "1rem", color: "var(--text-muted, #888)" }}
						>
							Loading...
						</div>
					</Show>
					<Show when={!actLoading() && activity().length === 0}>
						<div style={{ color: "var(--text-muted, #888)" }}>
							No activity yet
						</div>
					</Show>
				</Show>

				{/* Sessions tab */}
				<Show when={tab() === "sessions"}>
					<div>
						<For each={events()}>
							{(evt) => (
								<div
									style={{
										padding: "8px 0",
										"border-bottom": "1px solid var(--border-color, #eee)",
										"font-size": "0.85rem",
									}}
								>
									<span style={{ "font-weight": "500" }}>
										{evt.event === "login"
											? "Logged in"
											: evt.event === "logout"
												? "Logged out"
												: evt.event}
									</span>
									<Show when={evt.meta?.ip}>
										<span
											style={{
												color: "var(--text-muted, #888)",
												"margin-left": "6px",
											}}
										>
											from {evt.meta.ip}
										</span>
									</Show>
									<span
										style={{
											color: "var(--text-muted, #888)",
											"margin-left": "8px",
											"font-size": "0.75rem",
										}}
									>
										{formatDate(evt.created_at)}
									</span>
								</div>
							)}
						</For>
					</div>
					<Show when={evtHasMore() && !evtLoading()}>
						<button
							type="button"
							onClick={() => void loadEvents()}
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
					<Show when={evtLoading()}>
						<div
							style={{ "margin-top": "1rem", color: "var(--text-muted, #888)" }}
						>
							Loading...
						</div>
					</Show>
					<Show when={!evtLoading() && events().length === 0}>
						<div style={{ color: "var(--text-muted, #888)" }}>
							No session events yet
						</div>
					</Show>
				</Show>
			</div>
		</>
	);
}
