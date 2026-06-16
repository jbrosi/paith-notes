import * as d3 from "d3";
import type { GraphData, GraphEdge, GraphNode } from "./graphTypes";
import type { GraphLayout } from "./types";

export type GraphRenderConfig = {
	nookId: string;
	centerId: string;
	layout: GraphLayout;
	nodeSize: number;
	linkWidth: number;
	linkDistance: number;
	chargeStrength: number;
	onSelectNote: (id: string) => void;
	onHideNode: (id: string) => void;
};

export type GraphRenderResult = {
	simulation: d3.Simulation<GraphNode, undefined>;
	centerView: () => void;
};

function buildAdjacency(edges: GraphEdge[]) {
	const m = new Map<string, Array<{ next: string; edgeId: string }>>();
	for (const e of edges) {
		if (!m.has(e.source)) m.set(e.source, []);
		if (!m.has(e.target)) m.set(e.target, []);
		m.get(e.source)?.push({ next: e.target, edgeId: e.id });
		m.get(e.target)?.push({ next: e.source, edgeId: e.id });
	}
	return m;
}

function pathToCenter(
	fromId: string | null,
	centerId: string,
	adjacency: Map<string, Array<{ next: string; edgeId: string }>>,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
	const empty = { nodeIds: new Set<string>(), edgeIds: new Set<string>() };
	if (!fromId) return empty;
	const start = fromId.trim();
	const goal = centerId.trim();
	if (start === "" || goal === "") return empty;
	if (start === goal) return { nodeIds: new Set([start]), edgeIds: new Set() };

	const q: string[] = [start];
	const visited = new Set<string>([start]);
	const prev = new Map<string, { prevId: string; edgeId: string }>();

	while (q.length > 0) {
		const cur = q.shift();
		if (!cur) break;
		if (cur === goal) break;
		for (const n of adjacency.get(cur) ?? []) {
			if (visited.has(n.next)) continue;
			visited.add(n.next);
			prev.set(n.next, { prevId: cur, edgeId: n.edgeId });
			q.push(n.next);
		}
	}

	if (!prev.has(goal)) return empty;

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
}

function applyTreeLayout(
	nodes: GraphNode[],
	edges: GraphEdge[],
	centerId: string,
	layoutType: "tree" | "radial",
	width: number,
	height: number,
) {
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
	const nodeById = new Map(nodes.map((n) => [n.id, n]));

	if (layoutType === "tree") {
		d3.tree<HNode>().size([height - 40, width - 80])(root);
		for (const desc of root.descendants()) {
			const n = nodeById.get(desc.data.id);
			if (n) {
				n.x = (desc.y ?? 0) + 40;
				n.y = (desc.x ?? 0) + 20;
			}
		}
	} else {
		d3.tree<HNode>().size([2 * Math.PI, Math.min(width, height) / 2 - 40])(
			root,
		);
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

export function renderGraph(
	svgEl: SVGSVGElement,
	data: GraphData,
	config: GraphRenderConfig,
): GraphRenderResult | null {
	const bb = svgEl.getBoundingClientRect();
	const width = Math.max(200, Math.floor(bb.width));
	const height = Math.max(200, Math.floor(bb.height));

	const svg = d3.select(svgEl);
	svg.selectAll("*").remove();
	svg.attr("viewBox", `0 0 ${width} ${height}`);

	if (data.nodes.length === 0) return null;

	const viewport = svg.append("g");
	const zoom = d3
		.zoom<SVGSVGElement, unknown>()
		.scaleExtent([0.25, 3])
		.on("zoom", (event) => {
			viewport.attr("transform", String(event.transform));
		});
	svg.call(zoom);
	const centerView = () => {
		svg.transition().duration(150).call(zoom.transform, d3.zoomIdentity);
	};

	// Theme colors
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

	const { centerId, nodeSize: baseSize, linkWidth: currentLinkWidth } = config;
	const edges = data.edges.map((e) => ({ ...e }));
	const nodes = data.nodes.map((n) => ({ ...n }));

	// Edge groups
	const edgeG = viewport.append("g").attr("stroke", colorEdge);
	const nodeG = viewport.append("g");
	const labelG = viewport.append("g");
	const edgeLabelG = viewport.append("g");

	const linkHitSel = edgeG
		.selectAll("line.hit")
		.data(edges)
		.enter()
		.append("line")
		.attr("class", "hit")
		.attr("stroke", "transparent")
		.attr("stroke-width", 12)
		.style("pointer-events", "stroke")
		.style("cursor", "help");

	const linkSel = edgeG
		.selectAll("line.edge")
		.data(edges)
		.enter()
		.append("line")
		.attr("class", "edge")
		.attr("stroke-width", currentLinkWidth)
		.style("pointer-events", "none");

	linkSel.append("title").text((d) => d.label);

	const adjacency = buildAdjacency(edges);
	let hoveredId: string | null = null;
	let hoveredEdgeId: string | null = null;

	// Nodes
	const nodeLinkSel = nodeG
		.selectAll("a")
		.data(nodes)
		.enter()
		.append("a")
		.attr(
			"href",
			(d) => `/nooks/${config.nookId}/notes/${encodeURIComponent(d.id)}`,
		)
		.style("cursor", "pointer")
		.style("text-decoration", "none")
		.style("pointer-events", "all");

	nodeLinkSel.each(function (_d) {
		const el = d3.select(this as Element);
		const d = _d;
		const isCenter = d.id === centerId;
		const r = isCenter ? baseSize + 3 : baseSize;
		const fill = isCenter ? colorNodeCenter : colorNode;
		el.append("circle")
			.attr("r", r)
			.attr("fill", fill)
			.attr("stroke", "transparent")
			.attr("stroke-width", 2)
			.style("cursor", "pointer")
			.attr("class", "node-shape");
		el.append("title").text(d.label);
	});
	const nodeSel = nodeLinkSel.select<SVGElement>(".node-shape");

	// Labels
	const labelSel = labelG
		.selectAll("a")
		.data(nodes)
		.enter()
		.append("a")
		.attr(
			"href",
			(d) => `/nooks/${config.nookId}/notes/${encodeURIComponent(d.id)}`,
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

	// Drag
	const simulation: d3.Simulation<GraphNode, undefined>[] = [];
	const drag = d3
		.drag<SVGElement, GraphNode>()
		.on("start", (event, d) => {
			if (event.sourceEvent) event.sourceEvent.stopPropagation();
			const sim = simulation[0];
			if (!sim) return;
			if (!event.active) sim.alphaTarget(0.2).restart();
			d.fx = d.x ?? 0;
			d.fy = d.y ?? 0;
		})
		.on("drag", (event, d) => {
			d.fx = event.x;
			d.fy = event.y;
		})
		.on("end", (event, d) => {
			const sim = simulation[0];
			if (!sim) return;
			if (!event.active) sim.alphaTarget(0);
			d.fx = null;
			d.fy = null;
		});
	nodeSel.call(drag);

	// Edge labels
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

	// Hover
	const applyHover = () => {
		const hasFocus = hoveredId !== null;
		const path = pathToCenter(hoveredId, centerId, adjacency);
		const inPath = (id: string) => path.nodeIds.has(id);
		const edgeInPath = (id: string) => path.edgeIds.has(id);

		linkSel
			.attr("stroke", (d) =>
				edgeInPath(d.id) || hoveredEdgeId === d.id ? colorHighlight : colorEdge,
			)
			.attr("stroke-width", (d) =>
				edgeInPath(d.id) || hoveredEdgeId === d.id ? 2.5 : currentLinkWidth,
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

	// Click handler
	const handleNodeClick = (event: MouseEvent, d: GraphNode) => {
		if (event.button !== 0) return;
		if (event.ctrlKey || event.metaKey) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.shiftKey) {
			config.onHideNode(d.id);
			return;
		}
		config.onSelectNote(d.id);
	};

	// Event bindings
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

	// Layout
	if (config.layout === "tree" || config.layout === "radial") {
		applyTreeLayout(nodes, edges, centerId, config.layout, width, height);
	}

	// Simulation
	const sim = d3
		.forceSimulation(nodes)
		.force(
			"link",
			d3
				.forceLink<GraphNode, { source: string; target: string }>(
					edges as unknown as Array<{
						source: string;
						target: string;
					}>,
				)
				.id((d) => d.id)
				.distance(config.linkDistance)
				.strength(config.layout === "force" ? 0.7 : 0),
		)
		.force(
			"charge",
			d3
				.forceManyBody()
				.strength(config.layout === "force" ? config.chargeStrength : 0),
		)
		.force(
			"center",
			config.layout === "force" ? d3.forceCenter(width / 2, height / 2) : null,
		)
		.force("collide", d3.forceCollide().radius(baseSize + 4))
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

			nodeLinkSel.attr(
				"transform",
				(d) => `translate(${d.x ?? 0},${d.y ?? 0})`,
			);

			labelSel.attr(
				"transform",
				(d) => `translate(${(d.x ?? 0) + 10},${d.y ?? 0})`,
			);
		});

	simulation[0] = sim;

	return { simulation: sim, centerView };
}
