import { createMemo, createSignal, For, Show } from "solid-js";
import type { NookStore } from "../../pages/nook/store";
import styles from "../Nav.module.css";

export type NookTypeFilterDropdownProps = {
	store: NookStore | null;
};

export function NookTypeFilterDropdown(props: NookTypeFilterDropdownProps) {
	const store = () => props.store;
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	let inputRef: HTMLInputElement | undefined;

	const types = createMemo(() => store()?.noteTypes() ?? []);
	const selectedIds = createMemo(
		() => store()?.selectedTypeIds() ?? new Set<string>(),
	);
	const hasFilter = createMemo(() => selectedIds().size > 0);

	const treeItems = createMemo(() => {
		const all = types();
		const q = query().trim().toLowerCase();

		const matches =
			q === ""
				? all
				: all.filter(
						(t) =>
							t.label.toLowerCase().includes(q) ||
							t.key.toLowerCase().includes(q),
					);

		const includeIds = new Set<string>();
		if (q === "") {
			for (const t of all) includeIds.add(t.id);
		} else {
			const byId = new Map(all.map((t) => [t.id, t]));
			for (const t of matches) {
				includeIds.add(t.id);
				let p = t.parentId.trim();
				while (p !== "") {
					includeIds.add(p);
					p = byId.get(p)?.parentId.trim() ?? "";
				}
			}
		}

		const childrenByParent = new Map<string, typeof all>();
		for (const t of all) {
			if (!includeIds.has(t.id)) continue;
			const pid = t.parentId.trim();
			const list = childrenByParent.get(pid) ?? [];
			list.push(t);
			childrenByParent.set(pid, list);
		}
		for (const list of childrenByParent.values()) {
			list.sort((a, b) => a.label.localeCompare(b.label));
		}

		const out: Array<{
			id: string;
			label: string;
			key: string;
			depth: number;
		}> = [];
		const walk = (parentId: string, depth: number) => {
			for (const t of childrenByParent.get(parentId) ?? []) {
				out.push({ id: t.id, label: t.label, key: t.key, depth });
				walk(t.id, depth + 1);
			}
		};
		walk("", 0);
		return out;
	});

	const doOpen = () => {
		if (!store()) return;
		setQuery("");
		setOpen(true);
		requestAnimationFrame(() => inputRef?.focus());
	};

	const close = () => {
		setOpen(false);
		setQuery("");
	};

	const toggle = (id: string) => {
		store()?.toggleSelectedTypeId(id);
	};

	return (
		<div class={styles.dropdown}>
			<button
				type="button"
				class={`${styles.filterToggle} ${hasFilter() ? styles.filterToggleActive : ""}`}
				disabled={!store()}
				onClick={doOpen}
				title={
					hasFilter()
						? `Filtering by ${selectedIds().size} type(s)`
						: "Filter by type"
				}
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
					<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
				</svg>
				<Show when={hasFilter()}>
					<span class={styles.filterBadge}>{selectedIds().size}</span>
				</Show>
			</button>

			<Show when={open()}>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes */}
				<div class={styles.dropdownBackdrop} onClick={close} />
				<div class={styles["dropdown-menu"]}>
					<div class={styles.dropdownCloseBar}>
						<span>Filter by type</span>
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
					<div style={{ padding: "8px" }}>
						<input
							ref={inputRef}
							type="text"
							value={query()}
							placeholder="Search types..."
							onInput={(e) => setQuery(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") close();
							}}
							style={{
								width: "100%",
								padding: "6px 8px",
								border: "1px solid #ddd",
								"border-radius": "6px",
								"font-size": "0.875rem",
								outline: "none",
							}}
						/>
					</div>
					<div class={styles["dropdown-list"]}>
						<For each={treeItems()}>
							{(t) => (
								<label
									class={styles.typeCheckItem}
									style={{ "padding-left": `${10 + t.depth * 16}px` }}
								>
									<input
										type="checkbox"
										checked={selectedIds().has(t.id)}
										onChange={() => toggle(t.id)}
										class={styles.typeCheckbox}
									/>
									<span class={styles.typeCheckLabel}>{t.label}</span>
									<Show when={t.key.trim() !== ""}>
										<span class={styles["dropdown-meta"]}>{t.key}</span>
									</Show>
								</label>
							)}
						</For>
					</div>
					<Show when={hasFilter()}>
						<div class={styles.filterFooter}>
							<button
								type="button"
								class={styles.filterClearBtn}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => store()?.clearSelectedTypes()}
							>
								Clear all
							</button>
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
}
