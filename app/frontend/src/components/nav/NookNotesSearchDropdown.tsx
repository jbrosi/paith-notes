import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { normalizeToken, parseTypedSearch } from "../../noteSearch";
import type { NookStore } from "../../pages/nook/store";
import { SEARCH_DEBOUNCE_MS } from "../../settings";
import styles from "../Nav.module.css";

type NoteTitle = { id: string; title: string; type_id: string };

export type NookNotesSearchDropdownProps = {
	store: NookStore | null;
	onNewNote?: () => void;
	onUploadFile?: () => void;
};

export function NookNotesSearchDropdown(props: NookNotesSearchDropdownProps) {
	const storeReady = createMemo(() => props.store !== null);
	const store = () => props.store;

	const [open, setOpen] = createSignal<boolean>(false);
	let closeTimeout: number | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let inputRef: HTMLInputElement | undefined;
	let panelInputRef: HTMLInputElement | undefined;

	// Lean lazy fetch — only id+title+type_id, only when the dropdown
	// actually gets focused. Replaces the previous behavior of eagerly
	// loading 50 full notes on every nook open via the store.
	const [titles, setTitles] = createSignal<NoteTitle[]>([]);
	const [titlesLoaded, setTitlesLoaded] = createSignal(false);
	const loadTitles = async (q: string) => {
		const nookId = store()?.nookId() ?? "";
		if (nookId === "") return;
		const qs = new URLSearchParams();
		qs.set("limit", "20");
		if (q.trim() !== "") qs.set("q", q.trim());
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId}/notes/titles?${qs.toString()}`,
				{ method: "GET" },
			);
			if (!res.ok) return;
			const body = (await res.json()) as { notes?: NoteTitle[] };
			setTitles(body.notes ?? []);
			setTitlesLoaded(true);
		} catch {
			// best-effort — dropdown stays empty rather than throwing
		}
	};

	const noteResults = createMemo(() => titles().slice(0, 12));

	const query = createMemo(() => store()?.notesQuery() ?? "");

	/** Active type filter labels — from dropdown or type: syntax */
	const activeFilterLabels = createMemo(() => {
		const s = store();
		if (!s) return [];
		const ids = s.activeTypeIds();
		if (ids.size === 0) return [];
		const types = s.noteTypes();
		return [...ids]
			.map((id) => types.find((t) => t.id === id)?.label ?? "")
			.filter(Boolean);
	});

	/** Whether the type filter comes from type: syntax (vs the dropdown) */
	const isTypedFilter = createMemo(() => {
		const parsed = parseTypedSearch(query());
		return parsed.typeTerm.trim() !== "";
	});

	const isUnlinkedFilter = createMemo(() => parseTypedSearch(query()).unlinked);

	const typeSuggestions = createMemo(() => {
		const s = query().trim();
		if (s === "") return [];
		const types = store()?.noteTypes() ?? [];
		if (types.length === 0) return [];

		const parsed = parseTypedSearch(s);
		// Show suggestions when typing before the colon, or when no colon yet
		const termRaw = s.includes(":") ? parsed.typeTerm : s;
		const term = normalizeToken(termRaw);
		if (term === "") return [];

		const prefix: typeof types = [];
		const contains: typeof types = [];
		for (const t of types) {
			const label = normalizeToken(t.label);
			const key = normalizeToken(t.key);
			if (label.startsWith(term) || key.startsWith(term)) {
				prefix.push(t);
			} else if (label.includes(term) || key.includes(term)) {
				contains.push(t);
			}
		}
		return [...prefix, ...contains].slice(0, 6);
	});

	const onSearchInput = (val: string) => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			// Keep store's notesQuery in sync so things like the
			// "active filter" label memo stay accurate; the actual
			// fetch now happens locally so we don't depend on the
			// store's reactive effect for it.
			store()?.setNotesQuery(val);
			void loadTitles(val);
		}, SEARCH_DEBOUNCE_MS);
	};

	// Reset cache when the user switches nooks — the next focus will
	// fetch fresh titles for the new nook.
	createEffect(() => {
		store()?.nookId();
		setTitlesLoaded(false);
		setTitles([]);
	});

	const applyTypeSuggestion = (key: string) => {
		const fill = `${key}: `;
		store()?.setNotesQuery(fill);
		// Focus whichever input is visible
		inputRef?.focus();
		panelInputRef?.focus();
	};

	const handleFocus = () => {
		if (closeTimeout !== undefined) {
			window.clearTimeout(closeTimeout);
			closeTimeout = undefined;
		}
		setOpen(true);
		// Lazy fetch: first focus per nook triggers the load. Reopens
		// reuse the cached list until the user types or switches nooks.
		if (!titlesLoaded()) {
			void loadTitles(query());
		}
	};

	const handleBlur = () => {
		closeTimeout = window.setTimeout(() => setOpen(false), 150);
	};

	const handleToggle = () => {
		setOpen(true);
		requestAnimationFrame(() => panelInputRef?.focus());
	};

	const close = () => setOpen(false);

	const selectNote = (id: string) => {
		void store()?.onNoteLinkClick(id);
		close();
	};

	return (
		<div class={styles.dropdown}>
			{/* Toggle button — visible on mobile only */}
			<button
				type="button"
				class={styles.searchToggle}
				onClick={handleToggle}
				title="Search notes"
			>
				<svg
					aria-hidden="true"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<circle cx="11" cy="11" r="8" />
					<path d="m21 21-4.35-4.35" />
				</svg>
			</button>

			{/* Desktop/tablet: icon inside input */}
			<div class={styles.searchWrap}>
				<span class={styles.searchIcon}>
					<svg
						aria-hidden="true"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<path d="m21 21-4.35-4.35" />
					</svg>
				</span>
				<input
					ref={inputRef}
					type="text"
					disabled={!storeReady()}
					value={query()}
					placeholder="Search notes..."
					onInput={(e) => onSearchInput(e.currentTarget.value)}
					onFocus={handleFocus}
					onBlur={handleBlur}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							close();
							(e.target as HTMLElement).blur();
						}
					}}
					class={styles.searchInput}
				/>
			</div>

			<Show when={open()}>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes */}
				<div class={styles.dropdownBackdrop} onClick={close} />
				<div class={styles["dropdown-menu"]}>
					<div class={styles.dropdownCloseBar}>
						<span>Search notes</span>
						<button
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={close}
							style={{
								background: "none",
								border: "none",
								"font-size": "1.25rem",
								cursor: "pointer",
								padding: "0 4px",
								"line-height": "1",
							}}
						>
							&times;
						</button>
					</div>
					{/* Phone: search input inside the panel */}
					<div class={styles.dropdownSearchField}>
						<input
							ref={panelInputRef}
							type="text"
							disabled={!storeReady()}
							value={query()}
							placeholder="Search notes... (type: or unlinked:)"
							onInput={(e) => onSearchInput(e.currentTarget.value)}
							style={{
								width: "100%",
								padding: "10px 12px",
								border: "none",
								"border-bottom": "1px solid #eee",
								outline: "none",
								"font-size": "1rem",
								"font-family": "inherit",
							}}
						/>
					</div>
					{/* Type suggestion chips (while typing a type: prefix) */}
					<Show when={typeSuggestions().length > 0}>
						<div class={styles.typeSuggestions}>
							<For each={typeSuggestions()}>
								{(t) => (
									<button
										type="button"
										class={styles.typeSuggestionChip}
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => applyTypeSuggestion(t.key)}
									>
										{t.label}
									</button>
								)}
							</For>
						</div>
					</Show>
					{/* Active type filter indicator */}
					<Show
						when={
							(activeFilterLabels().length > 0 || isUnlinkedFilter()) &&
							typeSuggestions().length === 0
						}
					>
						<div class={styles.activeFilter}>
							<span class={styles.activeFilterLabel}>
								Filtered by:{" "}
								{[
									...(isUnlinkedFilter() ? ["Unlinked"] : []),
									...activeFilterLabels(),
								].join(", ")}
							</span>
							<Show when={!isTypedFilter()}>
								<button
									type="button"
									class={styles.activeFilterClear}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => store()?.clearSelectedTypes()}
									title="Clear type filter"
								>
									&times;
								</button>
							</Show>
						</div>
					</Show>
					<div class={styles["dropdown-list"]}>
						<For each={noteResults()}>
							{(n) => (
								<button
									type="button"
									class={styles["dropdown-item"]}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => selectNote(n.id)}
								>
									<span>{n.title}</span>
								</button>
							)}
						</For>
						<Show
							when={
								query().trim() !== "" &&
								(store()?.headingMatches()?.length ?? 0) > 0
							}
						>
							<div
								style={{
									padding: "4px 12px 2px",
									"font-size": "0.65rem",
									"font-weight": "600",
									color: "var(--color-text-muted)",
									"text-transform": "uppercase",
									"letter-spacing": "0.05em",
									"border-top": "1px solid var(--color-border-light, #eee)",
									"margin-top": "2px",
								}}
							>
								Heading matches
							</div>
							<For each={store()?.headingMatches() ?? []}>
								{(h) => (
									<button
										type="button"
										class={styles["dropdown-item"]}
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => selectNote(h.noteId)}
										style={{ "padding-left": `${12 + (h.level - 1) * 8}px` }}
									>
										<span
											style={{
												display: "flex",
												"flex-direction": "column",
												gap: "1px",
											}}
										>
											<span>{h.text}</span>
											<span
												style={{
													"font-size": "0.65rem",
													color: "var(--color-text-muted)",
												}}
											>
												{h.noteTitle}
											</span>
										</span>
									</button>
								)}
							</For>
						</Show>
					</div>
					{/* Create note options */}
					<div class={styles.dropdownFooter}>
						<Show when={query().trim() !== "" && noteResults().length === 0}>
							<button
								type="button"
								class={styles.createNoteItem}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									props.onNewNote?.();
									store()?.setTitle(query().trim());
									close();
								}}
							>
								+ Create "{query().trim()}"
							</button>
						</Show>
						<button
							type="button"
							class={styles.createNoteItem}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								props.onNewNote?.();
								close();
							}}
						>
							+ New note
						</button>
						<button
							type="button"
							class={styles.createNoteItem}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								props.onUploadFile?.();
								close();
							}}
						>
							+ Upload file
						</button>
					</div>
				</div>
			</Show>
		</div>
	);
}
