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
	type GraphLayout,
	type GraphViewProperties,
	type LinkPredicate,
	LinkPredicatesListResponseSchema,
	type NoteLink,
	NoteLinksListResponseSchema,
	NoteResponseSchema,
	serializeGraphProperties,
	TypeAttributesListResponseSchema,
} from "./types";

export type NookGraphPanelProps = {
	store: NookStore;
	fullscreen?: boolean;
	onClose?: () => void;
	/** Embedded mode: render as inline graph block for a graph-type note */
	embedded?: boolean;
	/** Root note ID override (used in embedded mode) */
	rootNoteId?: string;
	/** Initial config to seed filters (used in embedded mode) */
	initialConfig?: GraphViewProperties | null;
	/** Callback to save current filter state (used in embedded mode) */
	onSaveConfig?: (config: GraphViewProperties) => void;
	/** Called when embedded graph filters change (syncs config + marks dirty) */
	onDirty?: (config: GraphViewProperties) => void;
};

const GRAPH_WIDTH_STORAGE_KEY = "paith-notes:graphPanelWidth";
const DEFAULT_GRAPH_WIDTH = 300;
const MIN_GRAPH_WIDTH = 200;
const MAX_GRAPH_WIDTH_RATIO = 0.5;

function loadStoredWidth(): number {
	try {
		const v = localStorage.getItem(GRAPH_WIDTH_STORAGE_KEY);
		if (v) {
			const n = Number(v);
			if (Number.isFinite(n) && n >= MIN_GRAPH_WIDTH) return n;
		}
	} catch {
		/* ignore */
	}
	return DEFAULT_GRAPH_WIDTH;
}

export function NookGraphPanel(props: NookGraphPanelProps) {
	const navigate = useNavigate();
	const store = () => props.store;
	const nookId = () => store().nookId();
	const embedded = () => Boolean(props.embedded);
	const noteId = () => {
		if (embedded()) return props.rootNoteId ?? "";
		return store().selectedId();
	};
	const excludeNoteId = () => "";
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
		if (embedded()) {
			// Use setTimeout to read signals after they've been updated
			setTimeout(() => props.onDirty?.(currentConfig()), 0);
		}
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

	const onSaveConfig = () => {
		props.onSaveConfig?.(currentConfig());
	};

	const onSaveAsGraphNote = async () => {
		const config = currentConfig();
		if (config.rootNoteId === "") return;
		const n = nookId().trim();
		if (n === "") return;
		try {
			// Find the graph type and its graph attribute
			const types = store().noteTypes();
			const graphType = types.find((t) => t.key === "graph");
			if (!graphType) return;

			let graphAttrId = "";
			const attrRes = await apiFetch(
				`/api/nooks/${n}/note-types/${graphType.id}/attributes`,
			);
			if (attrRes.ok) {
				const attrJson = await attrRes.json();
				const attrs =
					TypeAttributesListResponseSchema.parse(attrJson).attributes;
				const graphAttr = attrs.find((a) => a.kind === "graph");
				if (graphAttr) graphAttrId = graphAttr.id;
			}
			if (!graphAttrId) return;

			const centerTitle = titleById().get(config.rootNoteId) ?? "";
			const attributes: Record<string, unknown> = {
				[graphAttrId]: serializeGraphProperties(config),
			};
			const res = await apiFetch(`/api/nooks/${n}/notes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: centerTitle ? `Graph: ${centerTitle}` : "Untitled Graph View",
					content: "",
					type_id: graphType.id,
					attributes,
				}),
			});
			if (!res.ok) return;
			const json = await res.json();
			const body = NoteResponseSchema.parse(json);
			navigate(
				`/nooks/${encodeURIComponent(n)}/notes/${encodeURIComponent(body.note.id)}`,
			);
		} catch {
			/* ignore */
		}
	};

	const [graphWidth, setGraphWidth] = createSignal(loadStoredWidth());

	const onResizeStart = (e: MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = graphWidth();
		const onMove = (ev: MouseEvent) => {
			const delta = startX - ev.clientX;
			const next = Math.max(
				MIN_GRAPH_WIDTH,
				Math.min(window.innerWidth * MAX_GRAPH_WIDTH_RATIO, startWidth + delta),
			);
			setGraphWidth(next);
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			try {
				localStorage.setItem(GRAPH_WIDTH_STORAGE_KEY, String(graphWidth()));
			} catch {
				/* ignore */
			}
		};
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};
	const selectNote = (id: string) => {
		void store().onNoteLinkClick(id);
	};

	const [loading, setLoading] = createSignal<boolean>(false);
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
		const centerTitle = embedded()
			? labelFor(centerId)
			: store().title().trim();
		const hidden = hiddenNodeIds();
		const exclude = excludeNoteId();

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
			if (exclude && (s === exclude || t === exclude)) continue;
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
	const onFullscreen = () => {
		if (embedded()) {
			const n = nookId().trim();
			const graphNoteId = store().selectedId().trim();
			if (n === "" || graphNoteId === "") return;
			navigate(
				`/nooks/${encodeURIComponent(n)}/notes/${encodeURIComponent(graphNoteId)}?fullscreen`,
			);
			return;
		}
		const n = nookId().trim();
		const note = noteId().trim();
		if (n === "" || note === "") return;
		navigate(
			`/nooks/${encodeURIComponent(n)}/graph/${encodeURIComponent(note)}`,
		);
	};
	const onCloseFullscreen = () => {
		const n = nookId().trim();
		// For embedded fullscreen, go back to the graph note (not the root note)
		const note = embedded() ? store().selectedId().trim() : noteId().trim();
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
			onOpenGraphNode: selectNote,
		});

		onCleanup(() => {
			currentRender?.simulation.stop();
		});
	});

	const handleClose = () => {
		if (fullscreen()) {
			onCloseFullscreen();
		} else {
			props.onClose?.();
		}
	};

	return (
		<div
			class={`${styles.container} ${fullscreen() && !embedded() ? styles.containerFullscreen : ""} ${embedded() ? (fullscreen() ? styles.containerEmbeddedFullscreen : styles.containerEmbedded) : ""}`}
			style={
				fullscreen() || embedded() ? undefined : { width: `${graphWidth()}px` }
			}
		>
			<Show when={!fullscreen() && !embedded()}>
				<hr
					tabIndex={0}
					class={styles.resizeHandle}
					onMouseDown={onResizeStart}
				/>
			</Show>
			<Show when={!embedded() || fullscreen()}>
				<div class={styles.header}>
					<div class={styles.title}>Graph</div>
					<button
						type="button"
						class={styles.closeBtn}
						onClick={handleClose}
						title={fullscreen() ? "Exit fullscreen" : "Close graph"}
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
				<Show
					when={embedded()}
					fallback={
						<button
							type="button"
							class={styles.controlBtn}
							onClick={onSaveAsGraphNote}
							disabled={noteId().trim() === ""}
							title="Save as graph view note"
						>
							Save as note
						</button>
					}
				>
					<button
						type="button"
						class={styles.controlBtn}
						onClick={onSaveConfig}
						disabled={noteId().trim() === ""}
						title="Save graph configuration"
					>
						Save
					</button>
				</Show>
				<Show when={!fullscreen()}>
					<button
						type="button"
						class={styles.controlBtn}
						onClick={onFullscreen}
						disabled={noteId().trim() === ""}
					>
						Fullscreen
					</button>
				</Show>
			</div>

			<Show when={noteId().trim() !== ""} fallback={<div>Select a note</div>}>
				<Show when={error() === ""} fallback={<pre>{error()}</pre>}>
					<div class={styles.canvasWrap}>
						<svg
							ref={(el) => {
								svgEl = el;
							}}
							class={`${styles.svgCanvas} ${fullscreen() ? styles.svgCanvasFullscreen : ""}`}
						/>
						<Show when={loading()}>
							<div
								class={styles.loadingOverlay}
								role="status"
								aria-label="Loading graph"
							>
								<span class={styles.loadingSpinner} />
								<span class={styles.loadingLabel}>Loading…</span>
							</div>
						</Show>
					</div>
				</Show>
			</Show>
		</div>
	);
}
