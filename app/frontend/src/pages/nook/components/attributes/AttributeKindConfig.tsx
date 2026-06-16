import { createEffect, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../../auth/keycloak";
import type { NookStore } from "../../store";
import {
	defaultAllowOverride,
	type LinkPredicate,
	LinkPredicatesListResponseSchema,
	OverrideCapableKinds,
	type TypeAttributeKind,
} from "../../types";

export type KindConfigState = {
	buildConfig: () => Record<string, unknown>;
};

/**
 * Renders kind-specific config UI and exposes buildConfig().
 * The parent passes the initial config and reads buildConfig() on save.
 */
export function AttributeKindConfig(props: {
	kind: TypeAttributeKind;
	config: Record<string, unknown>;
	ref: (state: KindConfigState) => void;
	/** Required for graph/linked_notes filter pickers (note types + predicates). */
	nookId?: string;
	store?: NookStore;
}) {
	// ── Shared state ────────────────────────────────────────────────────
	const [display, setDisplay] = createSignal(
		(props.config.display as string) ?? "",
	);
	const [options, setOptions] = createSignal(
		Array.isArray(props.config.options)
			? (props.config.options as string[]).join(", ")
			: "",
	);
	const [max, setMax] = createSignal(String(props.config.max ?? ""));
	const [currency, setCurrency] = createSignal(
		String(props.config.currency ?? "USD"),
	);

	// ── Linked notes / mentions ──────────────────────────────────────────
	const [lnDirection, setLnDirection] = createSignal(
		String(props.config.direction ?? "both"),
	);

	// ── History ─────────────────────────────────────────────────────────
	const [historyLimit, setHistoryLimit] = createSignal(
		String(props.config.limit ?? "5"),
	);

	// ── TOC ─────────────────────────────────────────────────────────────
	const [tocMaxDepth, setTocMaxDepth] = createSignal(
		String(props.config.max_depth ?? "3"),
	);

	// ── Content ─────────────────────────────────────────────────────────
	const [contentMode, setContentMode] = createSignal(
		String(props.config.mode ?? "markdown"),
	);

	// ── Metadata ────────────────────────────────────────────────────────
	const [mdShowVersion, setMdShowVersion] = createSignal(
		props.config.show_version !== false,
	);
	const [mdShowCreated, setMdShowCreated] = createSignal(
		props.config.show_created !== false,
	);
	const [mdShowUpdated, setMdShowUpdated] = createSignal(
		props.config.show_updated !== false,
	);
	const [mdShowViews, setMdShowViews] = createSignal(
		props.config.show_views !== false,
	);

	// ── Per-note override flag (generic, applies to view/aggregate kinds) ─
	const initialAllowOverride = (): boolean => {
		const v = props.config.allow_override_in_note;
		if (typeof v === "boolean") return v;
		return defaultAllowOverride(props.kind);
	};
	const [allowOverride, setAllowOverride] = createSignal(
		initialAllowOverride(),
	);

	// ── Filter pickers (shared by graph + linked_notes) ──────────────────
	const initialTypeIds = (): Set<string> =>
		Array.isArray(props.config.filter_type_ids)
			? new Set(
					(props.config.filter_type_ids as unknown[]).filter(
						(v): v is string => typeof v === "string",
					),
				)
			: new Set<string>();
	const initialPredicateIds = (): Set<string> =>
		Array.isArray(props.config.filter_predicate_ids)
			? new Set(
					(props.config.filter_predicate_ids as unknown[]).filter(
						(v): v is string => typeof v === "string",
					),
				)
			: new Set<string>();
	const [filterTypeIds, setFilterTypeIds] = createSignal(initialTypeIds());
	const [filterPredicateIds, setFilterPredicateIds] = createSignal(
		initialPredicateIds(),
	);

	const toggleTypeId = (id: string) => {
		const s = new Set(filterTypeIds());
		if (s.has(id)) s.delete(id);
		else s.add(id);
		setFilterTypeIds(s);
	};
	const togglePredicateId = (id: string) => {
		const s = new Set(filterPredicateIds());
		if (s.has(id)) s.delete(id);
		else s.add(id);
		setFilterPredicateIds(s);
	};

	const [predicates, setPredicates] = createSignal<LinkPredicate[]>([]);
	createEffect(() => {
		const nid = props.nookId;
		if (!nid) return;
		// Only fetch when this attribute kind actually uses predicates
		if (
			props.kind !== "graph" &&
			props.kind !== "linked_notes" &&
			props.kind !== "mentions"
		)
			return;
		void (async () => {
			try {
				const res = await apiFetch(`/api/nooks/${nid}/link-predicates`);
				if (!res.ok) return;
				const json = await res.json();
				setPredicates(LinkPredicatesListResponseSchema.parse(json).predicates);
			} catch {
				/* ignore */
			}
		})();
	});

	// ── Graph defaults ──────────────────────────────────────────────────
	const [graphDepth, setGraphDepth] = createSignal(
		String(props.config.depth ?? "2"),
	);
	const [graphLayout, setGraphLayout] = createSignal(
		String(props.config.layout ?? "force"),
	);
	const [graphLinkDistance, setGraphLinkDistance] = createSignal(
		String(props.config.link_distance ?? "90"),
	);
	const [graphChargeStrength, setGraphChargeStrength] = createSignal(
		String(props.config.charge_strength ?? "-280"),
	);
	const [graphNodeSize, setGraphNodeSize] = createSignal(
		String(props.config.node_size ?? "6"),
	);
	const [graphLinkWidth, setGraphLinkWidth] = createSignal(
		String(props.config.link_width ?? "1"),
	);

	// ── Build config ────────────────────────────────────────────────────
	const buildConfig = (): Record<string, unknown> => {
		const c: Record<string, unknown> = {};
		const k = props.kind;
		if (k === "select" || k === "multi_select") {
			c.options = options()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		if (display()) c.display = display();
		if (k === "number" && max()) c.max = Number(max());
		if (k === "number" && display() === "currency") {
			c.currency = currency().toUpperCase();
		}
		if (k === "linked_notes" || k === "mentions") {
			c.direction = lnDirection();
		}
		if (k === "history") c.limit = Number(historyLimit()) || 5;
		if (k === "toc") c.max_depth = Number(tocMaxDepth()) || 3;
		if (k === "content") c.mode = contentMode();
		if (k === "metadata") {
			c.show_version = mdShowVersion();
			c.show_created = mdShowCreated();
			c.show_updated = mdShowUpdated();
			c.show_views = mdShowViews();
		}
		if (k === "graph" || k === "linked_notes" || k === "mentions") {
			const ids = [...filterTypeIds()];
			if (ids.length) c.filter_type_ids = ids;
			const pids = [...filterPredicateIds()];
			if (pids.length) c.filter_predicate_ids = pids;
		}
		if (k === "graph") {
			const d = Number(graphDepth());
			if (Number.isFinite(d) && d >= 1 && d <= 5) c.depth = d;
			if (graphLayout() && graphLayout() !== "force") c.layout = graphLayout();
			const ld = Number(graphLinkDistance());
			if (Number.isFinite(ld) && ld >= 20 && ld <= 300) c.link_distance = ld;
			const cs = Number(graphChargeStrength());
			if (Number.isFinite(cs) && cs >= -1000 && cs <= 0) c.charge_strength = cs;
			const ns = Number(graphNodeSize());
			if (Number.isFinite(ns) && ns >= 3 && ns <= 20) c.node_size = ns;
			const lw = Number(graphLinkWidth());
			if (Number.isFinite(lw) && lw >= 0.5 && lw <= 5) c.link_width = lw;
		}
		if (OverrideCapableKinds.has(k)) {
			c.allow_override_in_note = allowOverride();
		}
		return c;
	};

	// Expose buildConfig to parent
	props.ref({ buildConfig });

	const s = { padding: "4px 6px", "font-size": "12px" } as const;

	return (
		<>
			<Show when={props.kind === "select" || props.kind === "multi_select"}>
				<input
					value={options()}
					onInput={(e) => setOptions(e.currentTarget.value)}
					placeholder="Options (comma-separated)"
					style={{ padding: "4px 6px" }}
				/>
			</Show>

			<Show when={props.kind === "text"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={s}
				>
					<option value="">Single line (default)</option>
					<option value="paragraph">Paragraph</option>
				</select>
			</Show>

			<Show when={props.kind === "number"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<select
						value={display()}
						onChange={(e) => setDisplay(e.currentTarget.value)}
						style={s}
					>
						<option value="">Plain number (default)</option>
						<option value="rating">Rating</option>
						<option value="duration">Duration (ms → human)</option>
						<option value="currency">Currency</option>
					</select>
					<Show when={display() === "rating"}>
						<input
							type="number"
							value={max()}
							onInput={(e) => setMax(e.currentTarget.value)}
							placeholder="Max (e.g. 5)"
							style={{ width: "80px", ...s }}
						/>
					</Show>
					<Show when={display() === "currency"}>
						<input
							type="text"
							value={currency()}
							onInput={(e) =>
								setCurrency(e.currentTarget.value.toUpperCase().slice(0, 3))
							}
							placeholder="USD"
							maxLength={3}
							style={{ width: "70px", "text-transform": "uppercase", ...s }}
							aria-label="ISO 4217 currency code"
						/>
					</Show>
				</div>
			</Show>

			<Show when={props.kind === "file"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={s}
				>
					<option value="">Download (default)</option>
					<option value="preview">Preview</option>
					<option value="player">Player</option>
				</select>
			</Show>

			<Show when={props.kind === "content"}>
				<select
					value={contentMode()}
					onChange={(e) => setContentMode(e.currentTarget.value)}
					style={s}
				>
					<option value="markdown">Markdown (default)</option>
					<option value="plain">Plain text</option>
					<option value="code">Code</option>
					<option value="hidden">Hidden (no content body)</option>
				</select>
			</Show>

			<Show when={props.kind === "linked_notes" || props.kind === "mentions"}>
				<select
					value={lnDirection()}
					onChange={(e) => setLnDirection(e.currentTarget.value)}
					style={s}
				>
					<option value="outgoing">Outgoing (from this note)</option>
					<option value="incoming">Incoming (to this note)</option>
					<option value="both">Both directions</option>
				</select>
			</Show>

			<Show when={props.kind === "history"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<label for="attr-history-limit" style={{ "font-size": "12px" }}>
						Show last
					</label>
					<input
						id="attr-history-limit"
						type="number"
						value={historyLimit()}
						onInput={(e) => setHistoryLimit(e.currentTarget.value)}
						min="0"
						max="50"
						style={{ width: "60px", ...s }}
					/>
					<span style={{ "font-size": "12px" }}>
						entries (0 = version info only)
					</span>
				</div>
			</Show>

			<Show when={props.kind === "metadata"}>
				<div
					style={{
						display: "flex",
						gap: "8px",
						"flex-wrap": "wrap",
						"font-size": "12px",
					}}
				>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowVersion()}
							onChange={(e) => setMdShowVersion(e.currentTarget.checked)}
						/>{" "}
						Version
					</label>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowCreated()}
							onChange={(e) => setMdShowCreated(e.currentTarget.checked)}
						/>{" "}
						Created
					</label>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowUpdated()}
							onChange={(e) => setMdShowUpdated(e.currentTarget.checked)}
						/>{" "}
						Last edited
					</label>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowViews()}
							onChange={(e) => setMdShowViews(e.currentTarget.checked)}
						/>{" "}
						View count
					</label>
				</div>
			</Show>

			<Show when={props.kind === "graph"}>
				<div
					style={{
						display: "grid",
						"grid-template-columns": "auto 1fr",
						gap: "6px 8px",
						"align-items": "center",
						"font-size": "12px",
					}}
				>
					<label for="attr-graph-depth">Default depth</label>
					<input
						id="attr-graph-depth"
						type="number"
						min="1"
						max="5"
						value={graphDepth()}
						onInput={(e) => setGraphDepth(e.currentTarget.value)}
						style={{ width: "70px", ...s }}
					/>
					<label for="attr-graph-layout">Default layout</label>
					<select
						id="attr-graph-layout"
						value={graphLayout()}
						onChange={(e) => setGraphLayout(e.currentTarget.value)}
						style={s}
					>
						<option value="force">Force</option>
						<option value="tree">Tree</option>
						<option value="radial">Radial</option>
					</select>
					<label for="attr-graph-link-distance">Link distance</label>
					<input
						id="attr-graph-link-distance"
						type="number"
						min="20"
						max="300"
						value={graphLinkDistance()}
						onInput={(e) => setGraphLinkDistance(e.currentTarget.value)}
						style={{ width: "70px", ...s }}
					/>
					<label for="attr-graph-charge">Charge strength</label>
					<input
						id="attr-graph-charge"
						type="number"
						min="-1000"
						max="0"
						value={graphChargeStrength()}
						onInput={(e) => setGraphChargeStrength(e.currentTarget.value)}
						style={{ width: "80px", ...s }}
					/>
					<label for="attr-graph-node-size">Node size</label>
					<input
						id="attr-graph-node-size"
						type="number"
						min="3"
						max="20"
						value={graphNodeSize()}
						onInput={(e) => setGraphNodeSize(e.currentTarget.value)}
						style={{ width: "70px", ...s }}
					/>
					<label for="attr-graph-link-width">Link width</label>
					<input
						id="attr-graph-link-width"
						type="number"
						min="0.5"
						max="5"
						step="0.5"
						value={graphLinkWidth()}
						onInput={(e) => setGraphLinkWidth(e.currentTarget.value)}
						style={{ width: "70px", ...s }}
					/>
				</div>
			</Show>

			<Show
				when={
					(props.kind === "graph" ||
						props.kind === "linked_notes" ||
						props.kind === "mentions") &&
					props.store
				}
			>
				<fieldset
					style={{
						border: "1px solid var(--color-border-light)",
						"border-radius": "4px",
						padding: "6px 8px",
						"font-size": "12px",
					}}
				>
					<legend style={{ "font-size": "11px", padding: "0 4px" }}>
						Default filters (empty = include all)
					</legend>
					<div style={{ "font-size": "11px", "margin-top": "2px" }}>
						Note types
					</div>
					<div
						style={{
							display: "flex",
							"flex-wrap": "wrap",
							gap: "4px 8px",
							"margin-bottom": "6px",
						}}
					>
						<For each={props.store?.noteTypes() ?? []}>
							{(t) => (
								<label
									style={{
										display: "flex",
										"align-items": "center",
										gap: "3px",
									}}
								>
									<input
										type="checkbox"
										checked={filterTypeIds().has(t.id)}
										onChange={() => toggleTypeId(t.id)}
									/>
									{t.label}
								</label>
							)}
						</For>
					</div>
					<div style={{ "font-size": "11px" }}>Link predicates</div>
					<div
						style={{
							display: "flex",
							"flex-wrap": "wrap",
							gap: "4px 8px",
						}}
					>
						<Show
							when={predicates().length > 0}
							fallback={
								<span style={{ color: "var(--color-text-muted)" }}>
									(no predicates defined)
								</span>
							}
						>
							<For each={predicates()}>
								{(p) => (
									<label
										style={{
											display: "flex",
											"align-items": "center",
											gap: "3px",
										}}
									>
										<input
											type="checkbox"
											checked={filterPredicateIds().has(p.id)}
											onChange={() => togglePredicateId(p.id)}
										/>
										{p.forwardLabel || p.key}
									</label>
								)}
							</For>
						</Show>
					</div>
				</fieldset>
			</Show>

			<Show when={OverrideCapableKinds.has(props.kind)}>
				<label
					style={{
						display: "flex",
						"align-items": "center",
						gap: "6px",
						"font-size": "12px",
					}}
				>
					<input
						type="checkbox"
						checked={allowOverride()}
						onChange={(e) => setAllowOverride(e.currentTarget.checked)}
					/>
					Allow per-note override of these settings
					<span
						style={{ color: "var(--color-text-muted)", "font-size": "11px" }}
					>
						(notes keep their saved overrides but won't display them when
						unchecked)
					</span>
				</label>
			</Show>

			<Show when={props.kind === "toc"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<label for="attr-toc-max-depth" style={{ "font-size": "12px" }}>
						Max heading depth
					</label>
					<select
						id="attr-toc-max-depth"
						value={tocMaxDepth()}
						onChange={(e) => setTocMaxDepth(e.currentTarget.value)}
						style={s}
					>
						<option value="1">h1 only</option>
						<option value="2">h1–h2</option>
						<option value="3">h1–h3</option>
						<option value="4">h1–h4</option>
						<option value="5">h1–h5</option>
						<option value="6">All levels</option>
					</select>
					<span
						style={{ "font-size": "11px", color: "var(--color-text-muted)" }}
					>
						(can be overridden per note)
					</span>
				</div>
			</Show>
		</>
	);
}
