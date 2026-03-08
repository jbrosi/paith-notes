import * as d3 from "d3";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import type { NookStore } from "./store";
import { type NoteLink, NoteLinksListResponseSchema } from "./types";

export type NookGraphPanelProps = {
	store: NookStore;
};

type GraphNode = {
	id: string;
	label: string;
	x?: number;
	y?: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
};

type GraphEdge = {
	source: string;
	target: string;
	label: string;
};

export function NookGraphPanel(props: NookGraphPanelProps) {
	const store = () => props.store;
	const nookId = () => store().nookId();
	const noteId = () => store().selectedId();
	const [depth, setDepth] = createSignal<number>(2);
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

	const loadLinks = async () => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") {
			setLinks([]);
			return;
		}
		const d = depth();
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links?direction=both&depth=${d}`,
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

	const graph = createMemo((): { nodes: GraphNode[]; edges: GraphEdge[] } => {
		const centerId = noteId().trim();
		if (centerId === "") return { nodes: [], edges: [] };
		const centerTitle = store().title().trim();

		const nodes = new Map<string, GraphNode>();
		nodes.set(centerId, {
			id: centerId,
			label: centerTitle !== "" ? centerTitle : labelFor(centerId),
		});

		const edges: GraphEdge[] = [];
		for (const l of links()) {
			const s = l.sourceNoteId.trim();
			const t = l.targetNoteId.trim();
			if (s === "" || t === "") continue;
			if (!nodes.has(s)) nodes.set(s, { id: s, label: labelFor(s) });
			if (!nodes.has(t)) nodes.set(t, { id: t, label: labelFor(t) });
			edges.push({
				source: s,
				target: t,
				label: l.forwardLabel,
			});
		}

		return { nodes: Array.from(nodes.values()), edges };
	});

	let svgEl: SVGSVGElement | undefined;
	let simulation: d3.Simulation<GraphNode, undefined> | undefined;
	let hoveredId: string | null = null;
	let centerView: (() => void) | undefined;
	const onCenter = () => centerView?.();

	createEffect(() => {
		const g = graph();
		if (!svgEl) return;

		const width = 280;
		const height = 420;

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

		const edges = g.edges.map((e) => ({ ...e }));
		const nodes = g.nodes.map((n) => ({ ...n }));

		const edgeG = viewport.append("g").attr("stroke", "#cbd5e1");
		const nodeG = viewport.append("g");
		const labelG = viewport.append("g");

		const linkSel = edgeG
			.selectAll("line")
			.data(edges)
			.enter()
			.append("line")
			.attr("stroke-width", 1);

		const centerId = noteId().trim();

		const nodeLinkSel = nodeG
			.selectAll("a")
			.data(nodes)
			.enter()
			.append("a")
			.attr(
				"href",
				(d) => `/nooks/${nookId()}?note=${encodeURIComponent(d.id)}`,
			)
			.attr("target", "_self")
			.attr("rel", "noopener")
			.style("cursor", "pointer")
			.style("text-decoration", "none")
			.style("pointer-events", "all");

		const nodeSel = nodeLinkSel
			.append("circle")
			.attr("r", (d) => (d.id === centerId ? 9 : 6))
			.attr("fill", (d) => (d.id === centerId ? "#0ea5e9" : "#94a3b8"))
			.attr("stroke", "transparent")
			.attr("stroke-width", 2)
			.style("cursor", "pointer");

		nodeSel.append("title").text((d) => d.label);

		const labelSel = labelG
			.selectAll("a")
			.data(nodes)
			.enter()
			.append("a")
			.attr(
				"href",
				(d) => `/nooks/${nookId()}?note=${encodeURIComponent(d.id)}`,
			)
			.attr("target", "_self")
			.attr("rel", "noopener")
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
			.attr("fill", "#334155")
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
			.drag<SVGCircleElement, GraphNode>()
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

		const applyHover = () => {
			nodeSel
				.attr("stroke", (d) => (d.id === hoveredId ? "#0ea5e9" : "transparent"))
				.attr("fill", (d) => {
					if (d.id === centerId) return "#0ea5e9";
					if (d.id === hoveredId) return "#64748b";
					return "#94a3b8";
				});
			labelTextSel.attr("font-weight", (d) => (d.id === hoveredId ? 700 : 400));
			labelRectSel.attr("fill", (d) =>
				d.id === hoveredId ? "#e2e8f0" : "transparent",
			);
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
			.on("click", (event, d) => {
				if (
					event.button !== 0 ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey ||
					event.altKey
				) {
					return;
				}
				event.preventDefault();
				selectNote(d.id);
			});

		labelSel
			.on("mouseenter", (_event, d) => {
				hoveredId = d.id;
				applyHover();
			})
			.on("mouseleave", () => {
				hoveredId = null;
				applyHover();
			})
			.on("click", (event, d) => {
				if (
					event.button !== 0 ||
					event.ctrlKey ||
					event.metaKey ||
					event.shiftKey ||
					event.altKey
				) {
					return;
				}
				event.preventDefault();
				selectNote(d.id);
			});

		applyHover();

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
					.distance(90)
					.strength(0.7),
			)
			.force("charge", d3.forceManyBody().strength(-280))
			.force("center", d3.forceCenter(width / 2, height / 2))
			.force("collide", d3.forceCollide().radius(18))
			.on("tick", () => {
				linkSel
					.attr("x1", (d) => (d.source as unknown as GraphNode).x ?? 0)
					.attr("y1", (d) => (d.source as unknown as GraphNode).y ?? 0)
					.attr("x2", (d) => (d.target as unknown as GraphNode).x ?? 0)
					.attr("y2", (d) => (d.target as unknown as GraphNode).y ?? 0);

				nodeSel.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);

				labelSel.attr(
					"transform",
					(d) => `translate(${(d.x ?? 0) + 10},${d.y ?? 0})`,
				);
			});

		onCleanup(() => {
			simulation?.stop();
		});
	});

	return (
		<div
			style={{
				width: "300px",
				border: "1px solid #eee",
				"border-radius": "8px",
				background: "#fafafa",
				padding: "10px",
			}}
		>
			<div style={{ display: "flex", "justify-content": "space-between" }}>
				<div style={{ "font-weight": 600 }}>Graph</div>
				<div style={{ display: "flex", gap: "6px" }}>
					<label
						style={{ display: "flex", gap: "6px", "align-items": "center" }}
					>
						<div style={{ "font-size": "12px", color: "#475569" }}>Depth</div>
						<select
							value={String(depth())}
							onChange={(e) => {
								const next = Number.parseInt(e.currentTarget.value, 10);
								setDepth(
									Number.isFinite(next) ? Math.min(5, Math.max(1, next)) : 2,
								);
							}}
							disabled={noteId().trim() === ""}
							style={{
								border: "1px solid #ddd",
								"border-radius": "6px",
								background: "white",
								padding: "4px 6px",
								cursor: "pointer",
								"font-size": "12px",
							}}
						>
							<option value="1">1</option>
							<option value="2">2</option>
							<option value="3">3</option>
							<option value="4">4</option>
							<option value="5">5</option>
						</select>
					</label>
					<button
						type="button"
						onClick={onCenter}
						disabled={noteId().trim() === ""}
						style={{
							border: "1px solid #ddd",
							"border-radius": "6px",
							background: "white",
							padding: "4px 8px",
							cursor: "pointer",
						}}
					>
						Center
					</button>
				</div>
			</div>

			<Show when={noteId().trim() !== ""} fallback={<div>Select a note</div>}>
				<Show when={error() === ""} fallback={<pre>{error()}</pre>}>
					<svg
						ref={(el) => {
							svgEl = el;
						}}
						style={{
							width: "100%",
							height: "420px",
							background: "white",
							border: "1px solid #eee",
							"border-radius": "6px",
							"margin-top": "8px",
						}}
					/>
				</Show>
			</Show>
		</div>
	);
}
