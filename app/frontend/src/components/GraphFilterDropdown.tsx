import { createMemo, createSignal, For, Show } from "solid-js";
import type { GraphLayout, LinkPredicate, NoteType } from "../pages/nook/types";
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
	// Display settings
	layout: GraphLayout;
	onLayoutChange: (layout: GraphLayout) => void;
	linkDistance: number;
	onLinkDistanceChange: (v: number) => void;
	chargeStrength: number;
	onChargeStrengthChange: (v: number) => void;
	nodeSize: number;
	onNodeSizeChange: (v: number) => void;
	linkWidth: number;
	onLinkWidthChange: (v: number) => void;
	strictTypeFilter: boolean;
	onStrictTypeFilterChange: (v: boolean) => void;
};

type Tab = "types" | "links" | "display";

export function GraphFilterDropdown(props: GraphFilterDropdownProps) {
	const [open, setOpen] = createSignal(false);
	const [tab, setTab] = createSignal<Tab>("types");
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

	const tabStyle = (t: Tab) => ({
		padding: "6px 12px",
		border: "none",
		background: tab() === t ? "var(--color-bg)" : "transparent",
		"border-bottom":
			tab() === t ? "2px solid var(--color-primary)" : "2px solid transparent",
		cursor: "pointer",
		"font-size": "0.8125rem",
		"font-weight": tab() === t ? "600" : "400",
		color: tab() === t ? "var(--color-text)" : "var(--color-text-muted)",
	});

	const rangeRow = (
		label: string,
		value: number,
		min: number,
		max: number,
		step: number,
		onChange: (v: number) => void,
	) => (
		<div
			style={{
				display: "flex",
				"align-items": "center",
				gap: "8px",
				padding: "4px 12px",
			}}
		>
			<span
				style={{
					"font-size": "0.8125rem",
					"min-width": "80px",
					color: "var(--color-text-muted)",
				}}
			>
				{label}
			</span>
			<input
				type="range"
				min={min}
				max={max}
				step={step}
				value={value}
				onInput={(e) => onChange(Number(e.currentTarget.value))}
				style={{ flex: "1" }}
			/>
			<span
				style={{
					"font-size": "0.75rem",
					"min-width": "32px",
					"text-align": "right",
					color: "var(--color-text-muted)",
				}}
			>
				{value}
			</span>
		</div>
	);

	return (
		<div class={navStyles.dropdown}>
			<button
				type="button"
				class={`${navStyles.filterToggle} ${hasFilter() ? navStyles.filterToggleActive : ""}`}
				disabled={props.disabled}
				onClick={doOpen}
				title={
					hasFilter() ? `${activeCount()} setting(s) active` : "Graph settings"
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
					<line x1="4" y1="21" x2="4" y2="14" />
					<line x1="4" y1="10" x2="4" y2="3" />
					<line x1="12" y1="21" x2="12" y2="12" />
					<line x1="12" y1="8" x2="12" y2="3" />
					<line x1="20" y1="21" x2="20" y2="16" />
					<line x1="20" y1="12" x2="20" y2="3" />
					<line x1="1" y1="14" x2="7" y2="14" />
					<line x1="9" y1="8" x2="15" y2="8" />
					<line x1="17" y1="16" x2="23" y2="16" />
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
						<span>Graph settings</span>
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

					{/* Tabs */}
					<div
						style={{
							display: "flex",
							"border-bottom": "1px solid var(--color-border-light)",
						}}
					>
						<button
							type="button"
							style={tabStyle("types")}
							onClick={() => setTab("types")}
						>
							Types
							{props.selectedTypeIds.size > 0
								? ` (${props.selectedTypeIds.size})`
								: ""}
						</button>
						<button
							type="button"
							style={tabStyle("links")}
							onClick={() => setTab("links")}
						>
							Links
							{props.selectedPredicateIds.size > 0
								? ` (${props.selectedPredicateIds.size})`
								: ""}
						</button>
						<button
							type="button"
							style={tabStyle("display")}
							onClick={() => setTab("display")}
						>
							Display
						</button>
					</div>

					{/* Types tab */}
					<Show when={tab() === "types"}>
						<Show when={props.selectedTypeIds.size > 0}>
							<label
								class={navStyles.typeCheckItem}
								style={{
									"border-bottom": "1px solid var(--color-border-light)",
								}}
							>
								<input
									type="checkbox"
									checked={props.strictTypeFilter}
									onChange={(e) =>
										props.onStrictTypeFilterChange(e.currentTarget.checked)
									}
									class={navStyles.typeCheckbox}
								/>
								<span class={navStyles.typeCheckLabel}>Strict filtering</span>
								<span class={navStyles["dropdown-meta"]}>
									{props.strictTypeFilter
										? "only matching nodes"
										: "show connections"}
								</span>
							</label>
						</Show>
						<div style={{ padding: "8px" }}>
							<input
								ref={inputRef}
								type="text"
								value={query()}
								placeholder="Search note types..."
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
						<Show when={props.selectedTypeIds.size > 0}>
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
					</Show>

					{/* Links tab */}
					<Show when={tab() === "links"}>
						<div style={{ padding: "8px" }}>
							<input
								ref={inputRef}
								type="text"
								value={query()}
								placeholder="Search link types..."
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
						<Show when={filteredPredicates().length > 0}>
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
												when={
													p.key.trim() !== "" && p.forwardLabel.trim() !== ""
												}
											>
												<span class={navStyles["dropdown-meta"]}>{p.key}</span>
											</Show>
										</label>
									)}
								</For>
							</div>
						</Show>
						<Show when={props.selectedPredicateIds.size > 0}>
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
					</Show>

					{/* Display tab */}
					<Show when={tab() === "display"}>
						<div style={{ padding: "8px 0" }}>
							<div
								style={{
									display: "flex",
									"align-items": "center",
									gap: "8px",
									padding: "4px 12px 8px",
								}}
							>
								<span
									style={{
										"font-size": "0.8125rem",
										"min-width": "80px",
										color: "var(--color-text-muted)",
									}}
								>
									Layout
								</span>
								<select
									value={props.layout}
									onChange={(e) =>
										props.onLayoutChange(e.currentTarget.value as GraphLayout)
									}
									style={{
										flex: "1",
										padding: "4px 6px",
										border: "1px solid var(--color-border)",
										"border-radius": "6px",
										background: "var(--color-bg)",
										color: "var(--color-text)",
										"font-size": "0.8125rem",
									}}
								>
									<option value="force">Force</option>
									<option value="tree">Tree</option>
									<option value="radial">Radial</option>
								</select>
							</div>
							{rangeRow(
								"Link dist.",
								props.linkDistance,
								20,
								300,
								5,
								props.onLinkDistanceChange,
							)}
							{rangeRow(
								"Repulsion",
								props.chargeStrength,
								-1000,
								0,
								10,
								props.onChargeStrengthChange,
							)}
							{rangeRow(
								"Node size",
								props.nodeSize,
								3,
								20,
								1,
								props.onNodeSizeChange,
							)}
							{rangeRow(
								"Link width",
								props.linkWidth,
								0.5,
								5,
								0.5,
								props.onLinkWidthChange,
							)}
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
}
