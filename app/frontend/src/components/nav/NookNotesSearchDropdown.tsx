import { createMemo, createSignal, For, Show } from "solid-js";
import { normalizeToken, parseTypedSearch } from "../../noteSearch";
import type { NookStore } from "../../pages/nook/store";
import styles from "../Nav.module.css";

export type NookNotesSearchDropdownProps = {
	store: NookStore | null;
};

export function NookNotesSearchDropdown(props: NookNotesSearchDropdownProps) {
	const storeReady = createMemo(() => props.store !== null);
	const store = () => props.store;

	const [open, setOpen] = createSignal<boolean>(false);
	let closeTimeout: number | undefined;
	let inputRef: HTMLInputElement | undefined;
	let panelInputRef: HTMLInputElement | undefined;

	const noteResults = createMemo(() => {
		const s = store();
		if (!s) return [];
		return s.notes().slice(0, 12);
	});

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
					onInput={(e) => store()?.setNotesQuery(e.currentTarget.value)}
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
							placeholder="Search notes... (type: to filter)"
							onInput={(e) => store()?.setNotesQuery(e.currentTarget.value)}
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
							activeFilterLabels().length > 0 && typeSuggestions().length === 0
						}
					>
						<div class={styles.activeFilter}>
							<span class={styles.activeFilterLabel}>
								Filtered by: {activeFilterLabels().join(", ")}
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
									<span class={styles["dropdown-meta"]}>{n.type}</span>
								</button>
							)}
						</For>
					</div>
					{/* Create note options */}
					<div class={styles.dropdownFooter}>
						<Show when={query().trim() !== "" && noteResults().length === 0}>
							<button
								type="button"
								class={styles.createNoteItem}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => {
									store()?.newNote();
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
								store()?.newNote();
								close();
							}}
						>
							+ New note
						</button>
					</div>
				</div>
			</Show>
		</div>
	);
}
