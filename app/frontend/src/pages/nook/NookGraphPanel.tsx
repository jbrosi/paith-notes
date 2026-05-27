import { useNavigate } from "@solidjs/router";
import * as d3 from "d3";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { GraphFilterDropdown } from "../../components/GraphFilterDropdown";
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
	/** Called when embedded graph filters change (to mark store dirty) */
	onDirty?: () => void;
};

type GraphNode = {
	id: string;
	label: string;
	noteType?: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
};

type GraphEdge = {
	id: string;
	source: string;
	target: string;
	label: string;
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
	const [overrideRootNoteId, setOverrideRootNoteId] = createSignal("");
	const noteId = () => {
		const override = overrideRootNoteId();
		if (override) return override;
		return embedded() ? (props.rootNoteId ?? "") : store().selectedId();
	};
	const fullscreen = () => Boolean(props.fullscreen);

	// Seed signals from initialConfig (embedded/graph note mode)
	const ic = props.initialConfig;
	const [depth, setDepth] = createSignal<number>(ic?.depth ?? 2);
	const [includeFiles, setIncludeFiles] = createSignal(
		ic?.includeFiles ?? false,
	);
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
		if (embedded()) props.onDirty?.();
	};

	// Graph view stack: navigate into graph nodes, back to return
	type GraphViewEntry = {
		rootNoteId: string;
		label: string;
		depth: number;
		includeFiles: boolean;
		filterTypeIds: string[];
		filterPredicateIds: string[];
		hiddenNodeIds: string[];
	};
	const [graphViewStack, setGraphViewStack] = createSignal<GraphViewEntry[]>(
		[],
	);
	const pushedView = () => {
		const stack = graphViewStack();
		return stack.length > 0 ? stack[stack.length - 1] : null;
	};

	const openGraphNode = async (graphNoteId: string) => {
		const n = nookId().trim();
		if (n === "") return;
		try {
			const noteRes = await apiFetch(`/api/nooks/${n}/notes/${graphNoteId}`, {
				method: "GET",
			});
			if (!noteRes.ok) return;
			const noteJson = await noteRes.json();
			const noteBody = NoteResponseSchema.parse(noteJson);
			const gp = noteBody.note.properties;
			const rootId = typeof gp?.rootNoteId === "string" ? gp.rootNoteId : "";
			if (rootId === "") return;

			// Save current view state before pushing
			const currentEntry: GraphViewEntry = {
				rootNoteId: noteId().trim(),
				label: titleById().get(noteId().trim()) ?? store().title().trim(),
				depth: depth(),
				includeFiles: includeFiles(),
				filterTypeIds: [...filterTypeIds()],
				filterPredicateIds: [...filterPredicateIds()],
				hiddenNodeIds: [...hiddenNodeIds()],
			};

			// Push current state and switch to the graph note's view
			setGraphViewStack([...graphViewStack(), currentEntry]);
			setOverrideRootNoteId(rootId);
			setDepth(typeof gp?.depth === "number" ? gp.depth : 2);
			setIncludeFiles(Boolean(gp?.includeFiles));
			setFilterTypeIds(
				Array.isArray(gp?.filterTypeIds)
					? new Set(gp.filterTypeIds as string[])
					: new Set<string>(),
			);
			setFilterPredicateIds(
				Array.isArray(gp?.filterPredicateIds)
					? new Set(gp.filterPredicateIds as string[])
					: new Set<string>(),
			);
			setHiddenNodeIds(
				Array.isArray(gp?.hiddenNodeIds)
					? new Set(gp.hiddenNodeIds as string[])
					: new Set<string>(),
			);
		} catch {
			/* ignore */
		}
	};

	const popGraphView = () => {
		const stack = graphViewStack();
		if (stack.length === 0) return;
		const prev = stack[stack.length - 1];
		setGraphViewStack(stack.slice(0, -1));
		setOverrideRootNoteId(stack.length > 1 ? prev.rootNoteId : "");
		setDepth(prev.depth);
		setIncludeFiles(prev.includeFiles);
		setFilterTypeIds(new Set(prev.filterTypeIds));
		setFilterPredicateIds(new Set(prev.filterPredicateIds));
		setHiddenNodeIds(new Set(prev.hiddenNodeIds));
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
		includeFiles: includeFiles(),
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
			const centerTitle = titleById().get(config.rootNoteId) ?? "";
			const res = await apiFetch(`/api/nooks/${n}/notes`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: centerTitle ? `Graph: ${centerTitle}` : "Untitled Graph View",
					content: "",
					type: "graph",
					properties: serializeGraphProperties(config),
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

	const noteTypeById = createMemo(() => {
		const m = new Map<string, string>();
		for (const l of links()) {
			if (l.sourceNoteId.trim() !== "" && l.sourceNoteType)
				m.set(l.sourceNoteId, l.sourceNoteType);
			if (l.targetNoteId.trim() !== "" && l.targetNoteType)
				m.set(l.targetNoteId, l.targetNoteType);
		}
		return m;
	});
	const noteTypeFor = (id: string) => noteTypeById().get(id) ?? "anything";

	const loadLinks = async () => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") {
			setLinks([]);
			return;
		}
		const d = depth();
		const excludeTypes = includeFiles() ? "" : "file";
		const typeIds = [...filterTypeIds()].join(",");
		const predIds = [...filterPredicateIds()].join(",");
		setLoading(true);
		setError("");
		try {
			const params = new URLSearchParams({
				direction: "both",
				depth: String(d),
			});
			if (excludeTypes) params.set("exclude_note_types", excludeTypes);
			if (typeIds) params.set("node_type_ids", typeIds);
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

	// Reset graph view stack when the base note changes
	createEffect(() => {
		store().selectedId(); // track
		if (graphViewStack().length > 0) {
			setGraphViewStack([]);
			setOverrideRootNoteId("");
		}
	});

	const graph = createMemo((): { nodes: GraphNode[]; edges: GraphEdge[] } => {
		const centerId = noteId().trim();
		if (centerId === "") return { nodes: [], edges: [] };
		const centerTitle =
			embedded() || overrideRootNoteId()
				? labelFor(centerId)
				: store().title().trim();
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
	let simulation: d3.Simulation<GraphNode, undefined> | undefined;
	let hoveredId: string | null = null;
	let centerView: (() => void) | undefined;
	const onCenter = () => centerView?.();
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
		const bb = svgEl.getBoundingClientRect();
		const width = Math.max(200, Math.floor(bb.width));
		const height = Math.max(200, Math.floor(bb.height));

		const svg = d3.select(svgEl);
		svg.selectAll("*").remove();
		svg.attr("viewBox", `0 0 ${width} ${height}`);

		if (g.nodes.length === 0) return;

		const viewport = svg.append("g");
		const zoom = d3
			.zoom<SVGSVGElement, unknown>()
			.scaleExtent([0.25, 3])
			.on("zoom", (event) => {
				viewport.attr("transform", String(event.transform));
			});
		svg.call(zoom);
		centerView = () => {
			svg.transition().duration(150).call(zoom.transform, d3.zoomIdentity);
		};

		// Read theme colors from CSS variables
		const cs = getComputedStyle(document.documentElement);
		const tv = (name: string, fallback: string) =>
			cs.getPropertyValue(name).trim() || fallback;
		const colorEdge = tv("--color-border-medium", "#cbd5e1");
		const colorNode = tv("--color-text-muted", "#94a3b8");
		const colorNodeCenter = tv("--color-primary-light", "#0ea5e9");
		const colorNodeHover = tv("--color-primary", "#0ea5e9");
		const colorHighlight = tv("--seed-accent", "#f59e0b");
		const colorLabel = tv("--color-text", "#334155");
		const colorEdgeLabel = tv("--color-text-muted", "#64748b");
		const colorEdgeLabelBg = tv("--color-bg", "#ffffff");
		const colorHoverBg = tv("--color-bg-hover", "#e2e8f0");
		const colorGraphNode = tv("--color-accent", "#8b5cf6");
		const _colorNodeStroke = tv("--color-bg", "#ffffff");

		const hexPath = (r: number) => {
			const a = Math.PI / 3;
			const pts = Array.from({ length: 6 }, (_, i) => {
				const angle = a * i - Math.PI / 6;
				return `${r * Math.cos(angle)},${r * Math.sin(angle)}`;
			});
			return `M${pts.join("L")}Z`;
		};

		const edges = g.edges.map((e) => ({ ...e }));
		const nodes = g.nodes.map((n) => ({ ...n }));

		const edgeG = viewport.append("g").attr("stroke", colorEdge);
		const nodeG = viewport.append("g");
		const labelG = viewport.append("g");
		const edgeLabelG = viewport.append("g");

		const edgeHitWidth = 12;

		const linkHitSel = edgeG
			.selectAll("line.hit")
			.data(edges)
			.enter()
			.append("line")
			.attr("class", "hit")
			.attr("stroke", "transparent")
			.attr("stroke-width", edgeHitWidth)
			.style("pointer-events", "stroke")
			.style("cursor", "help");

		const linkSel = edgeG
			.selectAll("line.edge")
			.data(edges)
			.enter()
			.append("line")
			.attr("class", "edge")
			.attr("stroke-width", 1)
			.style("pointer-events", "none");

		linkSel.append("title").text((d) => d.label);

		const centerId = noteId().trim();
		let hoveredEdgeId: string | null = null;

		const adjacency = (() => {
			const m = new Map<string, Array<{ next: string; edgeId: string }>>();
			for (const e of edges) {
				if (!m.has(e.source)) m.set(e.source, []);
				if (!m.has(e.target)) m.set(e.target, []);
				m.get(e.source)?.push({ next: e.target, edgeId: e.id });
				m.get(e.target)?.push({ next: e.source, edgeId: e.id });
			}
			return m;
		})();

		const pathToCenter = (
			fromId: string | null,
		): { nodeIds: Set<string>; edgeIds: Set<string> } => {
			if (!fromId) {
				return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
			}
			const start = fromId.trim();
			const goal = centerId.trim();
			if (start === "" || goal === "") {
				return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
			}
			if (start === goal) {
				return {
					nodeIds: new Set<string>([start]),
					edgeIds: new Set<string>(),
				};
			}

			const q: string[] = [start];
			const visited = new Set<string>([start]);
			const prev = new Map<string, { prevId: string; edgeId: string }>();

			while (q.length > 0) {
				const cur = q.shift();
				if (!cur) break;
				if (cur === goal) break;
				const nexts = adjacency.get(cur) ?? [];
				for (const n of nexts) {
					if (visited.has(n.next)) continue;
					visited.add(n.next);
					prev.set(n.next, { prevId: cur, edgeId: n.edgeId });
					q.push(n.next);
				}
			}

			if (!prev.has(goal)) {
				return { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
			}

			const nodeIds = new Set<string>();
			const edgeIds = new Set<string>();
			let cur = goal;
			nodeIds.add(cur);
			while (cur !== start) {
				const p = prev.get(cur);
				if (!p) break;
				edgeIds.add(p.edgeId);
				cur = p.prevId;
				nodeIds.add(cur);
			}
			return { nodeIds, edgeIds };
		};

		const nodeLinkSel = nodeG
			.selectAll("a")
			.data(nodes)
			.enter()
			.append("a")
			.attr(
				"href",
				(d) => `/nooks/${nookId()}/notes/${encodeURIComponent(d.id)}`,
			)
			.style("cursor", "pointer")
			.style("text-decoration", "none")
			.style("pointer-events", "all");

		// Draw circles for regular nodes, hexagons for graph nodes
		const baseSize = nodeSize();
		nodeLinkSel.each(function (_d) {
			const el = d3.select(this as Element);
			const d = _d;
			const isGraph = d.noteType === "graph";
			const isCenter = d.id === centerId;
			const r = isCenter ? baseSize + 3 : isGraph ? baseSize + 2 : baseSize;
			const fill = isCenter
				? colorNodeCenter
				: isGraph
					? colorGraphNode
					: colorNode;
			if (isGraph) {
				el.append("path")
					.attr("d", hexPath(r))
					.attr("fill", fill)
					.attr("stroke", "transparent")
					.attr("stroke-width", 2)
					.style("cursor", "pointer")
					.attr("class", "node-shape");
			} else {
				el.append("circle")
					.attr("r", r)
					.attr("fill", fill)
					.attr("stroke", "transparent")
					.attr("stroke-width", 2)
					.style("cursor", "pointer")
					.attr("class", "node-shape");
			}
			el.append("title").text(d.label);
		});
		const nodeSel = nodeLinkSel.select<SVGElement>(".node-shape");

		const labelSel = labelG
			.selectAll("a")
			.data(nodes)
			.enter()
			.append("a")
			.attr(
				"href",
				(d) => `/nooks/${nookId()}/notes/${encodeURIComponent(d.id)}`,
			)
			.style("cursor", "pointer")
			.style("text-decoration", "none")
			.style("pointer-events", "all");

		const labelGroupSel = labelSel.append("g").style("cursor", "pointer");

		const labelRectSel = labelGroupSel
			.append("rect")
			.attr("fill", "transparent")
			.attr("rx", 4)
			.attr("ry", 4)
			.style("pointer-events", "all");

		const labelTextSel = labelGroupSel
			.append("text")
			.text((d) => d.label)
			.attr("font-size", 10)
			.attr("fill", colorLabel)
			.attr("dominant-baseline", "middle");

		labelGroupSel.each(function (this: SVGGElement) {
			const textEl = d3.select(this).select<SVGTextElement>("text").node();
			if (!textEl) return;
			const bb = textEl.getBBox();
			const pad = 6;
			d3.select(this)
				.select("rect")
				.attr("x", bb.x - pad)
				.attr("y", bb.y - pad)
				.attr("width", bb.width + pad * 2)
				.attr("height", bb.height + pad * 2);
		});

		const drag = d3
			.drag<SVGElement, GraphNode>()
			.on("start", (event, d) => {
				if (event.sourceEvent) event.sourceEvent.stopPropagation();
				if (!simulation) return;
				if (!event.active) simulation.alphaTarget(0.2).restart();
				d.fx = d.x ?? 0;
				d.fy = d.y ?? 0;
			})
			.on("drag", (event, d) => {
				d.fx = event.x;
				d.fy = event.y;
			})
			.on("end", (event, d) => {
				if (!simulation) return;
				if (!event.active) simulation.alphaTarget(0);
				d.fx = null;
				d.fy = null;
			});

		nodeSel.call(drag);

		const edgeTextSel = edgeLabelG
			.selectAll("text")
			.data(edges)
			.enter()
			.append("text")
			.text((d) => d.label)
			.attr("font-size", 10)
			.attr("fill", colorEdgeLabel)
			.attr("text-anchor", "middle")
			.attr("dominant-baseline", "middle")
			.style("paint-order", "stroke")
			.style("stroke", colorEdgeLabelBg)
			.style("stroke-width", "3")
			.style("pointer-events", "none")
			.style("opacity", 0);

		const applyHover = () => {
			const hasFocus = hoveredId !== null;
			const path = pathToCenter(hoveredId);
			const inPath = (id: string) => path.nodeIds.has(id);
			const edgeInPath = (id: string) => path.edgeIds.has(id);

			linkSel
				.attr("stroke", (d) =>
					edgeInPath(d.id) || hoveredEdgeId === d.id
						? colorHighlight
						: colorEdge,
				)
				.attr("stroke-width", (d) =>
					edgeInPath(d.id) || hoveredEdgeId === d.id ? 2.5 : 1,
				)
				.style("opacity", (d) => {
					if (!hasFocus) return 1;
					if (hoveredEdgeId === d.id) return 1;
					return edgeInPath(d.id) ? 1 : 0.15;
				});

			nodeSel
				.attr("stroke", (d) => {
					if (d.id === hoveredId) return colorNodeHover;
					if (hasFocus && inPath(d.id) && d.id !== centerId)
						return colorHighlight;
					return "transparent";
				})
				.attr("stroke-width", (d) => {
					if (d.id === hoveredId) return 3;
					if (hasFocus && inPath(d.id) && d.id !== centerId) return 3;
					return 2;
				})
				.attr("fill", (d) => {
					if (d.id === centerId) return colorNodeCenter;
					if (d.noteType === "graph") return colorGraphNode;
					if (d.id === hoveredId) return colorEdgeLabel;
					return colorNode;
				});
			nodeSel.style("opacity", (d) => {
				if (!hasFocus) return 1;
				if (d.id === centerId) return 1;
				if (d.id === hoveredId) return 1;
				return inPath(d.id) ? 1 : 0.35;
			});
			labelSel.style("opacity", (d) => {
				if (!hasFocus) return 1;
				if (d.id === centerId) return 1;
				if (d.id === hoveredId) return 1;
				return inPath(d.id) ? 1 : 0.35;
			});
			labelTextSel.attr("font-weight", (d) => (d.id === hoveredId ? 700 : 400));
			labelRectSel.attr("fill", (d) =>
				d.id === hoveredId ? colorHoverBg : "transparent",
			);
			edgeTextSel.style("opacity", (d) => {
				if (hoveredEdgeId === d.id) return 1;
				if (!hasFocus) return 0;
				return edgeInPath(d.id) ? 1 : 0;
			});
		};

		const handleNodeClick = (event: MouseEvent, d: GraphNode) => {
			if (event.button !== 0) return;
			if (event.ctrlKey || event.metaKey) return; // let <a> handle open-in-new-tab
			event.preventDefault();
			event.stopPropagation(); // prevent SolidJS router from intercepting
			if (event.shiftKey) {
				hideNode(d.id);
				return;
			}
			if (d.noteType === "graph") {
				void openGraphNode(d.id);
				return;
			}
			selectNote(d.id);
		};

		nodeLinkSel
			.on("mouseenter", (_event, d) => {
				hoveredId = d.id;
				applyHover();
			})
			.on("mouseleave", () => {
				hoveredId = null;
				applyHover();
			})
			.on("click", (event, d) => handleNodeClick(event, d));

		labelSel
			.on("mouseenter", (_event, d) => {
				hoveredId = d.id;
				applyHover();
			})
			.on("mouseleave", () => {
				hoveredId = null;
				applyHover();
			})
			.on("click", (event, d) => handleNodeClick(event, d));

		linkHitSel
			.on("mouseenter", (_event, d) => {
				hoveredEdgeId = d.id;
				applyHover();
			})
			.on("mouseleave", () => {
				hoveredEdgeId = null;
				applyHover();
			});

		applyHover();

		const currentLayout = layout();
		const currentNodeSize = nodeSize();
		const currentLinkWidth = linkWidth();

		// Apply link width
		linkSel.attr("stroke-width", currentLinkWidth);

		// For tree/radial layouts, compute initial positions from hierarchy
		if (currentLayout === "tree" || currentLayout === "radial") {
			// Build a hierarchy rooted at centerId
			const childMap = new Map<string, string[]>();
			const hasParent = new Set<string>();
			for (const e of edges) {
				const src =
					typeof e.source === "string"
						? e.source
						: (e.source as unknown as GraphNode).id;
				const tgt =
					typeof e.target === "string"
						? e.target
						: (e.target as unknown as GraphNode).id;
				if (!childMap.has(src)) childMap.set(src, []);
				childMap.get(src)?.push(tgt);
				hasParent.add(tgt);
			}
			// Also add reverse edges for nodes not reachable forward
			for (const e of edges) {
				const src =
					typeof e.source === "string"
						? e.source
						: (e.source as unknown as GraphNode).id;
				const tgt =
					typeof e.target === "string"
						? e.target
						: (e.target as unknown as GraphNode).id;
				if (!childMap.has(tgt)) childMap.set(tgt, []);
				if (!hasParent.has(src) && src !== centerId) {
					childMap.get(tgt)?.push(src);
				}
			}

			type HNode = { id: string; children?: HNode[] };
			const visited = new Set<string>();
			const buildTree = (id: string): HNode => {
				visited.add(id);
				const kids = (childMap.get(id) ?? []).filter((c) => !visited.has(c));
				return {
					id,
					children: kids.length > 0 ? kids.map(buildTree) : undefined,
				};
			};
			const root = d3.hierarchy(buildTree(centerId));

			if (currentLayout === "tree") {
				const treeLayout = d3.tree<HNode>().size([height - 40, width - 80]);
				treeLayout(root);
				const nodeById = new Map(nodes.map((n) => [n.id, n]));
				for (const desc of root.descendants()) {
					const n = nodeById.get(desc.data.id);
					if (n) {
						n.x = (desc.y ?? 0) + 40;
						n.y = (desc.x ?? 0) + 20;
					}
				}
			} else {
				const radialLayout = d3
					.tree<HNode>()
					.size([2 * Math.PI, Math.min(width, height) / 2 - 40]);
				radialLayout(root);
				const nodeById = new Map(nodes.map((n) => [n.id, n]));
				for (const desc of root.descendants()) {
					const n = nodeById.get(desc.data.id);
					if (n) {
						const angle = desc.x ?? 0;
						const radius = desc.y ?? 0;
						n.x = width / 2 + radius * Math.cos(angle - Math.PI / 2);
						n.y = height / 2 + radius * Math.sin(angle - Math.PI / 2);
					}
				}
			}
		}

		simulation?.stop();
		simulation = d3
			.forceSimulation(nodes)
			.force(
				"link",
				d3
					.forceLink<GraphNode, { source: string; target: string }>(
						edges as unknown as Array<{ source: string; target: string }>,
					)
					.id((d) => d.id)
					.distance(linkDistance())
					.strength(currentLayout === "force" ? 0.7 : 0),
			)
			.force(
				"charge",
				d3
					.forceManyBody()
					.strength(currentLayout === "force" ? chargeStrength() : 0),
			)
			.force(
				"center",
				currentLayout === "force"
					? d3.forceCenter(width / 2, height / 2)
					: null,
			)
			.force("collide", d3.forceCollide().radius(currentNodeSize + 4))
			.on("tick", () => {
				linkSel
					.attr("x1", (d) => (d.source as unknown as GraphNode).x ?? 0)
					.attr("y1", (d) => (d.source as unknown as GraphNode).y ?? 0)
					.attr("x2", (d) => (d.target as unknown as GraphNode).x ?? 0)
					.attr("y2", (d) => (d.target as unknown as GraphNode).y ?? 0);

				linkHitSel
					.attr("x1", (d) => (d.source as unknown as GraphNode).x ?? 0)
					.attr("y1", (d) => (d.source as unknown as GraphNode).y ?? 0)
					.attr("x2", (d) => (d.target as unknown as GraphNode).x ?? 0)
					.attr("y2", (d) => (d.target as unknown as GraphNode).y ?? 0);

				edgeTextSel
					.attr(
						"x",
						(d) =>
							(((d.source as unknown as GraphNode).x ?? 0) +
								((d.target as unknown as GraphNode).x ?? 0)) /
							2,
					)
					.attr(
						"y",
						(d) =>
							(((d.source as unknown as GraphNode).y ?? 0) +
								((d.target as unknown as GraphNode).y ?? 0)) /
							2,
					);

				// Position the node wrappers (works for both circles and hexagon paths)
				nodeLinkSel.attr(
					"transform",
					(d) => `translate(${d.x ?? 0},${d.y ?? 0})`,
				);

				labelSel.attr(
					"transform",
					(d) => `translate(${(d.x ?? 0) + 10},${d.y ?? 0})`,
				);
			});

		onCleanup(() => {
			simulation?.stop();
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

			<Show when={pushedView()}>
				<div class={styles.graphBreadcrumb}>
					<button
						type="button"
						class={styles.controlBtn}
						onClick={popGraphView}
					>
						&larr; Back
					</button>
					<span class={styles.controlLabelText}>{pushedView()?.label}</span>
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
				<label class={styles.controlLabel}>
					<input
						type="checkbox"
						checked={includeFiles()}
						onChange={(e) => {
							setIncludeFiles(e.currentTarget.checked);
							markDirty();
						}}
						disabled={noteId().trim() === ""}
						class={styles.controlCheckbox}
					/>
					<span class={styles.controlLabelText}>Files</span>
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
