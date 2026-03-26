import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { apiFetch } from "../auth/keycloak";
import {
	normalizeToken,
	parseTypedSearch,
	resolveTypeForTerm,
} from "../noteSearch";

export type MentionDropdownProps = {
	x: number;
	y: number;
	query: string;
	nookId: string;
	noteTypes: Array<{
		id: string;
		key: string;
		label: string;
		parentId: string;
	}>;
	onSelect: (noteId: string, noteTitle: string) => void;
	onFillQuery: (fill: string) => void;
	onClose: () => void;
};

type NoteOption = {
	id: string;
	title: string;
	typeLabel?: string;
};

export function MentionDropdown(props: MentionDropdownProps) {
	const [results, setResults] = createSignal<NoteOption[]>([]);
	const [isLoading, setIsLoading] = createSignal(false);
	const [highlightIndex, setHighlightIndex] = createSignal(0);
	let dropdownRef: HTMLDivElement | undefined;

	// ── parsed query ──────────────────────────────────────────────────────────

	const parsedQuery = createMemo(() => parseTypedSearch(props.query));

	const matchingType = createMemo(() => {
		const { typeTerm } = parsedQuery();
		if (typeTerm === "") return null;
		return resolveTypeForTerm(props.noteTypes, typeTerm);
	});

	const effectiveTypeId = createMemo(() => matchingType()?.id ?? "");

	const effectiveTextQuery = createMemo(() => parsedQuery().textTerm.trim());

	// ── type suggestion chips ─────────────────────────────────────────────────

	const typeSuggestions = createMemo(() => {
		const s = props.query.trim();
		if (s === "") return [];
		const parsed = parsedQuery();
		const termRaw = s.includes(":") ? parsed.typeTerm : s;
		const term = normalizeToken(termRaw);
		if (term === "") return [];

		const prefix: typeof props.noteTypes = [];
		const contains: typeof props.noteTypes = [];
		for (const t of props.noteTypes) {
			const label = normalizeToken(t.label);
			const key = normalizeToken(t.key);
			if (label.startsWith(term) || key.startsWith(term)) {
				prefix.push(t);
				continue;
			}
			if (label.includes(term) || key.includes(term)) contains.push(t);
		}
		return [...prefix, ...contains].slice(0, 5).map((t) => ({
			key: t.key,
			label: `${t.key}:`,
			fill: `${t.key}: `,
		}));
	});

	// ── remote fetch ──────────────────────────────────────────────────────────

	createEffect(() => {
		const q = effectiveTextQuery();
		const typeId = effectiveTypeId();
		const nookId = props.nookId.trim();
		setHighlightIndex(0);
		if (nookId === "") return;

		const t = window.setTimeout(() => {
			void (async () => {
				setIsLoading(true);
				try {
					const typeForApi = typeId !== "" ? typeId : "all";
					const qs = new URLSearchParams();
					qs.set("include_subtypes", "1");
					qs.set("limit", "8");
					if (q !== "") qs.set("q", q);
					const res = await apiFetch(
						`/api/nooks/${nookId}/note-types/${typeForApi}/notes?${qs.toString()}`,
						{ method: "GET" },
					);
					if (!res.ok) throw new Error(`Search failed: ${res.status}`);
					const json = await res.json();
					const rawNotes = (json as { notes?: unknown })?.notes;
					const list = Array.isArray(rawNotes) ? rawNotes : [];
					const typeLabelById = new Map(
						props.noteTypes.map((t) => [t.id, t.label]),
					);
					const out: NoteOption[] = [];
					for (const n of list) {
						if (!n || typeof n !== "object") continue;
						const obj = n as Record<string, unknown>;
						const id = typeof obj.id === "string" ? obj.id : "";
						if (!id.trim()) continue;
						const optTypeId =
							typeof obj.type_id === "string" ? obj.type_id : "";
						out.push({
							id,
							title: typeof obj.title === "string" ? obj.title : id,
							typeLabel: typeLabelById.get(optTypeId) ?? undefined,
						});
					}
					setResults(out);
				} catch {
					setResults([]);
				} finally {
					setIsLoading(false);
				}
			})();
		}, 150);
		return () => window.clearTimeout(t);
	});

	// ── click-outside ─────────────────────────────────────────────────────────

	onMount(() => {
		const handler = (e: MouseEvent) => {
			if (dropdownRef && !dropdownRef.contains(e.target as Node)) {
				props.onClose();
			}
		};
		document.addEventListener("mousedown", handler);
		onCleanup(() => document.removeEventListener("mousedown", handler));
	});

	// ── keyboard navigation ───────────────────────────────────────────────────

	onMount(() => {
		const handler = (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHighlightIndex((i) =>
					results().length === 0 ? 0 : Math.min(i + 1, results().length - 1),
				);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setHighlightIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				const opt = results()[highlightIndex()];
				if (opt) {
					e.preventDefault();
					e.stopPropagation();
					props.onSelect(opt.id, opt.title);
				}
			}
		};
		document.addEventListener("keydown", handler, true);
		onCleanup(() => document.removeEventListener("keydown", handler, true));
	});

	// ── positioning ───────────────────────────────────────────────────────────

	const top = () => {
		const viewportH = window.innerHeight;
		const dropdownH = 260;
		return viewportH - props.y >= dropdownH
			? props.y + 4
			: props.y - dropdownH - 4;
	};

	return (
		<div
			ref={dropdownRef}
			style={{
				position: "fixed",
				left: `${props.x}px`,
				top: `${top()}px`,
				"z-index": "9999",
				background: "white",
				border: "1px solid #ddd",
				"border-radius": "8px",
				"box-shadow": "0 4px 16px rgba(0,0,0,0.12)",
				"min-width": "220px",
				"max-height": "260px",
				overflow: "auto",
				"font-size": "14px",
				"font-family":
					'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, "Noto Sans", sans-serif',
			}}
		>
			{/* Type suggestion chips */}
			<Show when={typeSuggestions().length > 0}>
				<div
					style={{
						display: "flex",
						gap: "6px",
						"flex-wrap": "wrap",
						padding: "8px 10px 4px",
						"border-bottom": "1px solid #f0f0f0",
					}}
				>
					<For each={typeSuggestions()}>
						{(s) => (
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									props.onFillQuery(s.fill);
								}}
								style={{
									border: "1px solid #ddd",
									"border-radius": "999px",
									padding: "2px 8px",
									background: "white",
									cursor: "pointer",
									"font-size": "12px",
									"font-family": "inherit",
								}}
							>
								{s.label}
							</button>
						)}
					</For>
				</div>
			</Show>

			{/* Active type filter badge */}
			<Show when={matchingType() !== null}>
				<div
					style={{
						padding: "4px 10px",
						"font-size": "11px",
						color: "#1d4ed8",
						background: "#eff6ff",
						"border-bottom": "1px solid #bfdbfe",
					}}
				>
					{matchingType()?.label}
				</div>
			</Show>

			{/* Results */}
			<Show when={isLoading()}>
				<div style={{ padding: "8px 12px", color: "#888" }}>Searching…</div>
			</Show>
			<Show when={!isLoading() && results().length === 0}>
				<div style={{ padding: "8px 12px", color: "#888" }}>
					{props.query.trim() === "" ? "Type to search notes…" : "No results"}
				</div>
			</Show>
			<For each={results()}>
				{(opt, idx) => (
					<button
						type="button"
						onMouseEnter={() => setHighlightIndex(idx())}
						onMouseDown={(e) => {
							e.preventDefault();
							props.onSelect(opt.id, opt.title);
						}}
						style={{
							display: "block",
							width: "100%",
							padding: "7px 12px",
							"text-align": "left",
							border: "none",
							background:
								highlightIndex() === idx() ? "#f0f4ff" : "transparent",
							cursor: "pointer",
							"font-family": "inherit",
						}}
					>
						<div style={{ "font-weight": 600 }}>{opt.title}</div>
						<Show when={opt.typeLabel}>
							<div style={{ "font-size": "11px", color: "#9ca3af" }}>
								{opt.typeLabel}
							</div>
						</Show>
					</button>
				)}
			</For>
		</div>
	);
}
