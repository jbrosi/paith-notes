import { createMemo, createSignal, For, Show } from "solid-js";
import type { LinkPredicate, NoteType } from "../pages/nook/types";
import navStyles from "./Nav.module.css";

export type GraphFilterDropdownProps = {
	noteTypes: NoteType[];
	predicates: LinkPredicate[];
	selectedTypeIds: Set<string>;
	selectedPredicateIds: Set<string>;
	onToggleTypeId: (id: string) => void;
	onTogglePredicateId: (id: string) => void;
	onClearAll: () => void;
	disabled?: boolean;
};

export function GraphFilterDropdown(props: GraphFilterDropdownProps) {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	let inputRef: HTMLInputElement | undefined;

	const activeCount = createMemo(
		() => props.selectedTypeIds.size + props.selectedPredicateIds.size,
	);
	const hasFilter = createMemo(() => activeCount() > 0);

	const treeItems = createMemo(() => {
		const all = props.noteTypes;
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

	const filteredPredicates = createMemo(() => {
		const q = query().trim().toLowerCase();
		if (q === "") return props.predicates;
		return props.predicates.filter(
			(p) =>
				p.forwardLabel.toLowerCase().includes(q) ||
				p.reverseLabel.toLowerCase().includes(q) ||
				p.key.toLowerCase().includes(q),
		);
	});

	const doOpen = () => {
		setQuery("");
		setOpen(true);
		requestAnimationFrame(() => inputRef?.focus());
	};

	const close = () => {
		setOpen(false);
		setQuery("");
	};

	return (
		<div class={navStyles.dropdown}>
			<button
				type="button"
				class={`${navStyles.filterToggle} ${hasFilter() ? navStyles.filterToggleActive : ""}`}
				disabled={props.disabled}
				onClick={doOpen}
				title={
					hasFilter() ? `${activeCount()} filter(s) active` : "Filter graph"
				}
			>
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
					<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
				</svg>
				<Show when={hasFilter()}>
					<span class={navStyles.filterBadge}>{activeCount()}</span>
				</Show>
			</button>

			<Show when={open()}>
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click closes */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes */}
				<div class={navStyles.dropdownBackdrop} onClick={close} />
				<div class={navStyles["dropdown-menu"]}>
					<div class={navStyles.dropdownCloseBar}>
						<span>Filter graph</span>
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
							placeholder="Search types & predicates..."
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

					<Show when={treeItems().length > 0}>
						<div class={navStyles.dropdownSection}>
							<div class={navStyles.dropdownSectionTitle}>Note Types</div>
						</div>
						<div class={navStyles["dropdown-list"]}>
							<For each={treeItems()}>
								{(t) => (
									<label
										class={navStyles.typeCheckItem}
										style={{
											"padding-left": `${10 + t.depth * 16}px`,
										}}
									>
										<input
											type="checkbox"
											checked={props.selectedTypeIds.has(t.id)}
											onChange={() => props.onToggleTypeId(t.id)}
											class={navStyles.typeCheckbox}
										/>
										<span class={navStyles.typeCheckLabel}>{t.label}</span>
										<Show when={t.key.trim() !== ""}>
											<span class={navStyles["dropdown-meta"]}>{t.key}</span>
										</Show>
									</label>
								)}
							</For>
						</div>
					</Show>

					<Show when={filteredPredicates().length > 0}>
						<div class={navStyles.dropdownSection}>
							<div class={navStyles.dropdownSectionTitle}>Link Types</div>
						</div>
						<div class={navStyles["dropdown-list"]}>
							<For each={filteredPredicates()}>
								{(p) => (
									<label class={navStyles.typeCheckItem}>
										<input
											type="checkbox"
											checked={props.selectedPredicateIds.has(p.id)}
											onChange={() => props.onTogglePredicateId(p.id)}
											class={navStyles.typeCheckbox}
										/>
										<span class={navStyles.typeCheckLabel}>
											{p.forwardLabel || p.key}
										</span>
										<Show
											when={p.key.trim() !== "" && p.forwardLabel.trim() !== ""}
										>
											<span class={navStyles["dropdown-meta"]}>{p.key}</span>
										</Show>
									</label>
								)}
							</For>
						</div>
					</Show>

					<Show when={hasFilter()}>
						<div class={navStyles.filterFooter}>
							<button
								type="button"
								class={navStyles.filterClearBtn}
								onMouseDown={(e) => e.preventDefault()}
								onClick={props.onClearAll}
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
