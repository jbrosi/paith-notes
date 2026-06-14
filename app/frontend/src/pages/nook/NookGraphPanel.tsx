import { useNavigate } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { GraphFilterDropdown } from "../../components/GraphFilterDropdown";
import { renderGraph } from "./graphRenderer";
import type { GraphData, GraphEdge, GraphNode } from "./graphTypes";
import styles from "./NookGraphPanel.module.css";
import type { NookStore } from "./store";
import {
	buildGraphShareUrl,
	type GraphLayout,
	type GraphViewProperties,
	type LinkPredicate,
	LinkPredicatesListResponseSchema,
	type NoteLink,
	NoteLinksListResponseSchema,
} from "./types";

export type NookGraphPanelProps = {
	store: NookStore;
	/** Whether to render as a fullscreen overlay (escapes parent layout). */
	fullscreen?: boolean;
	/** Note ID at the center of the graph (the "root" of traversal). */
	rootNoteId?: string;
	/** Initial config to seed filters + display knobs. */
	initialConfig?: GraphViewProperties | null;
	/** Called on every config change (syncs config + marks dirty). */
	onDirty?: (config: GraphViewProperties) => void;
	/** Reset per-note override back to type-level defaults. Provided only
	 * when reset makes sense (edit mode + allow_override_in_note on). */
	onReset?: () => void;
};

export function NookGraphPanel(props: NookGraphPanelProps) {
	const navigate = useNavigate();
	const store = () => props.store;
	const nookId = () => store().nookId();
	const noteId = () => props.rootNoteId ?? "";
	const fullscreen = () => Boolean(props.fullscreen);

	// Seed signals from initialConfig (embedded/graph note mode)
	const ic = props.initialConfig;
	const [depth, setDepth] = createSignal<number>(ic?.depth ?? 2);
	const [filterTypeIds, setFilterTypeIds] = createSignal(
		ic?.filterTypeIds?.length ? new Set(ic.filterTypeIds) : new Set<string>(),
	);
	const [filterPredicateIds, setFilterPredicateIds] = createSignal(
		ic?.filterPredicateIds?.length
			? new Set(ic.filterPredicateIds)
			: new Set<string>(),
	);
	const [hiddenNodeIds, setHiddenNodeIds] = createSignal(
		ic?.hiddenNodeIds?.length ? new Set(ic.hiddenNodeIds) : new Set<string>(),
	);
	// Display settings
	const [layout, setLayout] = createSignal<GraphLayout>(ic?.layout ?? "force");
	const [linkDistance, setLinkDistance] = createSignal(ic?.linkDistance ?? 90);
	const [chargeStrength, setChargeStrength] = createSignal(
		ic?.chargeStrength ?? -280,
	);
	const [nodeSize, setNodeSize] = createSignal(ic?.nodeSize ?? 6);
	const [linkWidth, setLinkWidth] = createSignal(ic?.linkWidth ?? 1);
	const [strictTypeFilter, setStrictTypeFilter] = createSignal(true);

	// Re-seed all internal signals on every initialConfig change.
	// This catches both note-switch (rootNoteId changes) and the
	// follow-up "note attributes just finished loading" update —
	// the second one used to be skipped by a rootNoteId guard, which
	// meant clicking a graph node navigated to the new note but
	// rendered with the previous note's settings until something
	// else forced a refresh.
	//
	// Safe to re-seed unconditionally because the user's own edits
	// propagate INTO the signals first, then cycle out through
	// onConfigChange → store → props.initialConfig; by the time the
	// new value arrives back here, the internal signals already
	// match, and Solid's setSignal is a no-op when the value is
	// equal — no spurious re-renders.
	createEffect(() => {
		const next = props.initialConfig;
		setDepth(next?.depth ?? 2);
		setFilterTypeIds(
			next?.filterTypeIds?.length
				? new Set(next.filterTypeIds)
				: new Set<string>(),
		);
		setFilterPredicateIds(
			next?.filterPredicateIds?.length
				? new Set(next.filterPredicateIds)
				: new Set<string>(),
		);
		setHiddenNodeIds(
			next?.hiddenNodeIds?.length
				? new Set(next.hiddenNodeIds)
				: new Set<string>(),
		);
		setLayout(next?.layout ?? "force");
		setLinkDistance(next?.linkDistance ?? 90);
		setChargeStrength(next?.chargeStrength ?? -280);
		setNodeSize(next?.nodeSize ?? 6);
		setLinkWidth(next?.linkWidth ?? 1);
	});

	const [predicates, setPredicates] = createSignal<LinkPredicate[]>([]);

	const loadPredicates = async () => {
		const n = nookId().trim();
		if (n === "") return;
		try {
			const res = await apiFetch(`/api/nooks/${n}/link-predicates`, {
				method: "GET",
			});
			if (res.ok) {
				const json = await res.json();
				const body = LinkPredicatesListResponseSchema.parse(json);
				setPredicates(body.predicates);
			}
		} catch {
			/* ignore */
		}
	};
	createEffect(() => {
		void loadPredicates();
	});

	const markDirty = () => {
		// setTimeout so signals settle before we serialize them.
		setTimeout(() => props.onDirty?.(currentConfig()), 0);
	};

	const toggleFilterTypeId = (id: string) => {
		const s = new Set(filterTypeIds());
		if (s.has(id)) s.delete(id);
		else s.add(id);
		setFilterTypeIds(s);
		markDirty();
	};
	const toggleFilterPredicateId = (id: string) => {
		const s = new Set(filterPredicateIds());
		if (s.has(id)) s.delete(id);
		else s.add(id);
		setFilterPredicateIds(s);
		markDirty();
	};
	const clearAllFilters = () => {
		setFilterTypeIds(new Set<string>());
		setFilterPredicateIds(new Set<string>());
		markDirty();
	};

	const hideNode = (id: string) => {
		const centerId = noteId().trim();
		if (id === centerId) return;
		const s = new Set(hiddenNodeIds());
		s.add(id);
		setHiddenNodeIds(s);
		markDirty();
	};
	const unhideAll = () => {
		setHiddenNodeIds(new Set<string>());
		markDirty();
	};
	const hiddenCount = createMemo(() => hiddenNodeIds().size);

	const currentConfig = (): GraphViewProperties => ({
		rootNoteId: noteId().trim(),
		depth: depth(),
		filterTypeIds: [...filterTypeIds()],
		filterPredicateIds: [...filterPredicateIds()],
		hiddenNodeIds: [...hiddenNodeIds()],
		layout: layout(),
		linkDistance: linkDistance(),
		chargeStrength: chargeStrength(),
		nodeSize: nodeSize(),
		linkWidth: linkWidth(),
	});

	const [justCopied, setJustCopied] = createSignal<boolean>(false);
	let copyResetHandle: ReturnType<typeof setTimeout> | undefined;
	const copyShareUrl = async () => {
		const url = buildGraphShareUrl(nookId(), currentConfig());
		const absolute =
			typeof window !== "undefined" && window.location?.origin
				? `${window.location.origin}${url}`
				: url;
		try {
			await navigator.clipboard.writeText(absolute);
			setJustCopied(true);
			if (copyResetHandle) clearTimeout(copyResetHandle);
			copyResetHandle = setTimeout(() => setJustCopied(false), 1500);
		} catch {
			/* clipboard API not available; silent no-op */
		}
	};

	const selectNote = (id: string) => {
		void store().onNoteLinkClick(id);
	};

	const [_loading, setLoading] = createSignal<boolean>(false);
	const [error, setError] = createSignal<string>("");
	const [links, setLinks] = createSignal<NoteLink[]>([]);

	const titleById = createMemo(() => {
		const m = new Map<string, string>();
		for (const l of links()) {
			if (l.sourceNoteId.trim() !== "") {
				m.set(
					l.sourceNoteId,
					l.sourceNoteTitle?.trim() ? l.sourceNoteTitle : l.sourceNoteId,
				);
			}
			if (l.targetNoteId.trim() !== "") {
				m.set(
					l.targetNoteId,
					l.targetNoteTitle?.trim() ? l.targetNoteTitle : l.targetNoteId,
				);
			}
		}
		return m;
	});

	const labelFor = (id: string) => titleById().get(id) ?? id;

	const noteTypeFor = (_id: string) => "anything";

	const loadLinks = async () => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") {
			setLinks([]);
			return;
		}
		const d = depth();
		const typeIds = [...filterTypeIds()].join(",");
		const predIds = [...filterPredicateIds()].join(",");
		setLoading(true);
		setError("");
		try {
			const params = new URLSearchParams({
				direction: "both",
				depth: String(d),
			});
			if (typeIds) params.set("node_type_ids", typeIds);
			if (typeIds && strictTypeFilter()) params.set("strict_type_filter", "1");
			if (predIds) params.set("predicate_ids", predIds);
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links?${params.toString()}`,
				{ method: "GET" },
			);
			if (!res.ok) {
				throw new Error(
					`Failed to load links: ${res.status} ${res.statusText}`,
				);
			}
			const json = await res.json();
			const body = NoteLinksListResponseSchema.parse(json);
			setLinks(body.links);
			// Populate title cache from link data
			const titles: Array<{ id: string; title: string }> = [];
			for (const l of body.links) {
				if (l.sourceNoteId && l.sourceNoteTitle)
					titles.push({ id: l.sourceNoteId, title: l.sourceNoteTitle });
				if (l.targetNoteId && l.targetNoteTitle)
					titles.push({ id: l.targetNoteId, title: l.targetNoteTitle });
			}
			store().cacheTitles(titles);
		} catch (e) {
			setLinks([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	createEffect(() => {
		void loadLinks();
	});

	const graph = createMemo((): GraphData => {
		const centerId = noteId().trim();
		if (centerId === "") return { nodes: [], edges: [] };
		const centerTitle = labelFor(centerId);
		const hidden = hiddenNodeIds();

		const nodes = new Map<string, GraphNode>();
		nodes.set(centerId, {
			id: centerId,
			label: centerTitle !== "" ? centerTitle : labelFor(centerId),
			noteType: noteTypeFor(centerId),
		});

		const edges: GraphEdge[] = [];
		for (const l of links()) {
			const s = l.sourceNoteId.trim();
			const t = l.targetNoteId.trim();
			if (s === "" || t === "") continue;
			if (hidden.has(s) || hidden.has(t)) continue;
			if (!nodes.has(s))
				nodes.set(s, {
					id: s,
					label: labelFor(s),
					noteType: noteTypeFor(s),
				});
			if (!nodes.has(t))
				nodes.set(t, {
					id: t,
					label: labelFor(t),
					noteType: noteTypeFor(t),
				});
			const edgeLabel = l.forwardLabel?.trim()
				? l.forwardLabel
				: l.predicateKey;
			edges.push({
				id: l.id,
				source: s,
				target: t,
				label: edgeLabel,
			});
		}

		return { nodes: Array.from(nodes.values()), edges };
	});

	let svgEl: SVGSVGElement | undefined;
	let currentRender: ReturnType<typeof renderGraph> = null;
	const onCenter = () => currentRender?.centerView();
	const onCloseFullscreen = () => {
		const n = nookId().trim();
		// Go back to the host note (the one whose graph attribute we're
		// viewing), not the graph's root node — the root may be a
		// different note we navigated through.
		const note = store().selectedId().trim();
		if (n === "") return;
		if (note !== "") {
			navigate(
				`/nooks/${encodeURIComponent(n)}/notes/${encodeURIComponent(note)}`,
			);
			return;
		}
		navigate(`/nooks/${encodeURIComponent(n)}`);
	};

	createEffect(() => {
		const g = graph();
		if (!svgEl) return;

		// Read reactive signals to track dependencies
		const currentLayout = layout();
		const currentNodeSize = nodeSize();
		const currentLinkWidth = linkWidth();
		const currentLinkDistance = linkDistance();
		const currentChargeStrength = chargeStrength();

		currentRender?.simulation.stop();
		currentRender = renderGraph(svgEl, g, {
			nookId: nookId(),
			centerId: noteId().trim(),
			layout: currentLayout,
			nodeSize: currentNodeSize,
			linkWidth: currentLinkWidth,
			linkDistance: currentLinkDistance,
			chargeStrength: currentChargeStrength,
			onSelectNote: selectNote,
			onHideNode: hideNode,
		});

		onCleanup(() => {
			currentRender?.simulation.stop();
		});
	});

	return (
		<div
			class={`${styles.container} ${fullscreen() ? styles.containerEmbeddedFullscreen : styles.containerEmbedded}`}
		>
			<Show when={fullscreen()}>
				<div class={styles.header}>
					<div class={styles.title}>Graph</div>
					<button
						type="button"
						class={styles.closeBtn}
						onClick={onCloseFullscreen}
						title="Exit fullscreen"
					>
						&times;
					</button>
				</div>
			</Show>

			<div class={styles.controls}>
				<label class={styles.controlLabel}>
					<span class={styles.controlLabelText}>Depth</span>
					<select
						value={String(depth())}
						onChange={(e) => {
							const next = Number.parseInt(e.currentTarget.value, 10);
							setDepth(
								Number.isFinite(next) ? Math.min(5, Math.max(1, next)) : 2,
							);
							markDirty();
						}}
						disabled={noteId().trim() === ""}
						class={styles.controlSelect}
					>
						<option value="1">1</option>
						<option value="2">2</option>
						<option value="3">3</option>
						<option value="4">4</option>
						<option value="5">5</option>
					</select>
				</label>
				<GraphFilterDropdown
					noteTypes={store().noteTypes()}
					predicates={predicates()}
					selectedTypeIds={filterTypeIds()}
					selectedPredicateIds={filterPredicateIds()}
					onToggleTypeId={toggleFilterTypeId}
					onTogglePredicateId={toggleFilterPredicateId}
					onClearAll={clearAllFilters}
					disabled={noteId().trim() === ""}
					layout={layout()}
					onLayoutChange={(v) => {
						setLayout(v);
						markDirty();
					}}
					linkDistance={linkDistance()}
					onLinkDistanceChange={(v) => {
						setLinkDistance(v);
						markDirty();
					}}
					chargeStrength={chargeStrength()}
					onChargeStrengthChange={(v) => {
						setChargeStrength(v);
						markDirty();
					}}
					nodeSize={nodeSize()}
					onNodeSizeChange={(v) => {
						setNodeSize(v);
						markDirty();
					}}
					linkWidth={linkWidth()}
					onLinkWidthChange={(v) => {
						setLinkWidth(v);
						markDirty();
					}}
					strictTypeFilter={strictTypeFilter()}
					onStrictTypeFilterChange={setStrictTypeFilter}
				/>
				<Show when={hiddenCount() > 0}>
					<button
						type="button"
						class={styles.controlBtn}
						onClick={unhideAll}
						title="Unhide all hidden nodes"
					>
						{hiddenCount()} hidden &times;
					</button>
				</Show>
				<button
					type="button"
					class={styles.controlBtn}
					onClick={onCenter}
					disabled={noteId().trim() === ""}
				>
					Center
				</button>
				<button
					type="button"
					class={styles.controlBtn}
					onClick={() => void copyShareUrl()}
					disabled={noteId().trim() === ""}
					title="Copy shareable link to this graph view"
				>
					{justCopied() ? "Copied!" : "Copy link"}
				</button>
				<Show when={props.onReset}>
					<button
						type="button"
						class={styles.controlBtn}
						onClick={() => props.onReset?.()}
						disabled={noteId().trim() === ""}
						title="Reset graph configuration to type defaults"
					>
						Reset
					</button>
				</Show>
			</div>

			<Show when={noteId().trim() !== ""} fallback={<div>Select a note</div>}>
				<Show when={error() === ""} fallback={<pre>{error()}</pre>}>
					<svg
						ref={(el) => {
							svgEl = el;
						}}
						class={`${styles.svgCanvas} ${fullscreen() ? styles.svgCanvasFullscreen : ""}`}
					/>
				</Show>
			</Show>
		</div>
	);
}
