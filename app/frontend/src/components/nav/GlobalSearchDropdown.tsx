import { A } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import styles from "../Nav.module.css";

type SearchResult = {
	id: string;
	title: string;
	nook_id: string;
	nook_name: string;
	type: string;
};

export function GlobalSearchDropdown() {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const [results, setResults] = createSignal<SearchResult[]>([]);
	const [loading, setLoading] = createSignal(false);
	let inputRef: HTMLInputElement | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	const doSearch = async (q: string) => {
		if (q.trim() === "") {
			setResults([]);
			return;
		}
		setLoading(true);
		try {
			const res = await apiFetch(
				`/api/search?q=${encodeURIComponent(q.trim())}&limit=12`,
				{ method: "GET" },
			);
			if (!res.ok) return;
			const body = (await res.json()) as { notes?: SearchResult[] };
			setResults(body?.notes ?? []);
		} catch {
			setResults([]);
		} finally {
			setLoading(false);
		}
	};

	const onInput = (val: string) => {
		setQuery(val);
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => void doSearch(val), 250);
	};

	const close = () => {
		setOpen(false);
		setQuery("");
		setResults([]);
	};

	let closeTimeout: number | undefined;
	const handleFocus = () => {
		if (closeTimeout !== undefined) {
			window.clearTimeout(closeTimeout);
			closeTimeout = undefined;
		}
		setOpen(true);
	};
	const handleBlur = () => {
		closeTimeout = window.setTimeout(close, 200);
	};

	return (
		<div class={styles.dropdown}>
			<button
				type="button"
				onClick={() => {
					setOpen(true);
					requestAnimationFrame(() => inputRef?.focus());
				}}
				title="Search all nooks"
				style={{
					display: "inline-flex",
					"align-items": "center",
					"justify-content": "center",
					padding: "0.375rem 0.5rem",
					border: "1px solid var(--color-border, #ddd)",
					"border-radius": "4px",
					background: "var(--color-bg, #fff)",
					cursor: "pointer",
					color: "var(--color-text-muted, #888)",
					"line-height": "1",
				}}
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

			<Show when={open()}>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop */}
				<div class={styles.dropdownBackdrop} onClick={close} />
				<div class={styles["dropdown-menu"]} style={{ "min-width": "320px" }}>
					<div class={styles.dropdownCloseBar}>
						<span>Search all nooks</span>
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
					<div style={{ padding: "0" }}>
						<input
							ref={inputRef}
							type="text"
							value={query()}
							placeholder="Search across all nooks..."
							onInput={(e) => onInput(e.currentTarget.value)}
							onFocus={handleFocus}
							onBlur={handleBlur}
							onKeyDown={(e) => {
								if (e.key === "Escape") close();
							}}
							style={{
								width: "100%",
								padding: "10px 12px",
								border: "none",
								"border-bottom": "1px solid var(--color-border-light, #eee)",
								outline: "none",
								"font-size": "0.9rem",
								"font-family": "inherit",
								"box-sizing": "border-box",
								background: "transparent",
								color: "inherit",
							}}
						/>
					</div>
					<Show when={loading()}>
						<div
							style={{
								padding: "12px",
								color: "var(--color-text-muted)",
								"font-size": "0.8rem",
							}}
						>
							Searching...
						</div>
					</Show>
					<Show
						when={!loading() && query().trim() !== "" && results().length === 0}
					>
						<div
							style={{
								padding: "12px",
								color: "var(--color-text-muted)",
								"font-size": "0.8rem",
							}}
						>
							No results
						</div>
					</Show>
					<Show when={results().length > 0}>
						<div
							class={styles["dropdown-list"]}
							style={{ "max-height": "320px", "overflow-y": "auto" }}
						>
							<For each={results()}>
								{(note) => (
									<A
										href={`/nooks/${encodeURIComponent(note.nook_id)}/notes/${encodeURIComponent(note.id)}`}
										class={styles["dropdown-item"]}
										style={{
											"text-decoration": "none",
											color: "inherit",
											display: "block",
											padding: "8px 12px",
										}}
										onClick={close}
									>
										<div
											style={{ "font-weight": "500", "font-size": "0.85rem" }}
										>
											{note.title || "(untitled)"}
										</div>
										<div
											style={{
												"font-size": "0.7rem",
												color: "var(--color-text-muted)",
											}}
										>
											{note.nook_name}
										</div>
									</A>
								)}
							</For>
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
}
