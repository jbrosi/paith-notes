import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../auth/keycloak";
import {
	normalizeToken,
	parseTypedSearch,
	resolveTypeForTerm,
} from "../noteSearch";
import type { NoteSearchOption } from "./NoteSearchSelect";

export type RemoteNoteSearchSelectProps = {
	value: string;
	onChange: (nextId: string, option: NoteSearchOption | null) => void;
	nookId: string;
	noteTypes: Array<{
		id: string;
		key: string;
		label: string;
		parentId: string;
	}>;
	excludeIds?: string[];
	placeholder?: string;
	disabled?: boolean;
	isTypeAllowed?: (typeId: string) => boolean;
	allowedTypesLabel?: string;
};

export function RemoteNoteSearchSelect(props: RemoteNoteSearchSelectProps) {
	const [draft, setDraft] = createSignal<string>("");
	const [hint, setHint] = createSignal<string>("");
	const [results, setResults] = createSignal<NoteSearchOption[]>([]);
	const [hasFocus, setHasFocus] = createSignal<boolean>(false);
	const [isOpen, setIsOpen] = createSignal<boolean>(false);
	const [highlightIndex, setHighlightIndex] = createSignal<number>(-1);
	const [selectedTitle, setSelectedTitle] = createSignal<string>("");
	let inputRef: HTMLInputElement | undefined;

	// ── typed search parsing (same as sidebar) ──
	const parsedSearch = createMemo(() => parseTypedSearch(draft()));

	const matchingType = createMemo(() => {
		const { typeTerm } = parsedSearch();
		if (typeTerm === "") return null;
		return resolveTypeForTerm(props.noteTypes, typeTerm);
	});

	const showUnknownTypeHint = createMemo(() => {
		const { typeTerm } = parsedSearch();
		if (typeTerm.trim() === "") return false;
		if (props.noteTypes.length === 0) return false;
		return matchingType() === null && resolveKindForTerm(typeTerm) === "";
	});

	// ── type suggestion chips (same logic as sidebar) ──
	const typeSuggestions = createMemo(() => {
		if (!hasFocus()) return [];
		const s = draft().trim();
		if (s === "") return [];
		const parsed = parsedSearch();
		const termRaw = s.includes(":") ? parsed.typeTerm : s;
		const term = normalizeToken(termRaw);
		if (term === "") return [];

		const out: Array<{ key: string; label: string; fill: string }> = [];

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
		for (const t of [...prefix, ...contains].slice(0, 6)) {
			out.push({ key: t.key, label: `${t.key}:`, fill: `${t.key}: ` });
		}

		return out;
	});

	const applyTypeSuggestion = (fill: string) => {
		setDraft(fill);
		inputRef?.focus();
	};

	// ── derived query state ──
	const typeLabelById = createMemo(() => {
		const m = new Map<string, string>();
		for (const t of props.noteTypes) m.set(t.id, t.label);
		return m;
	});

	const effectiveTypeId = createMemo(() => {
		const typed = matchingType();
		return typed?.id ?? "";
	});

	function resolveKindForTerm(
		termRaw: string,
	): "anything" | "person" | "file" | "" {
		const term = normalizeToken(termRaw);
		if (term === "") return "";
		if ("person".startsWith(term) || term === "pe") return "person";
		if ("file".startsWith(term) || term === "fi") return "file";
		if (
			"anything".startsWith(term) ||
			term === "an" ||
			term === "note" ||
			term === "no"
		)
			return "anything";
		return "";
	}

	const effectiveKind = createMemo(() => {
		const typeTerm = parsedSearch().typeTerm;
		if (typeTerm.trim() === "") return "";
		if (effectiveTypeId().trim() !== "") return "";
		return resolveKindForTerm(typeTerm);
	});

	const effectiveTextQuery = createMemo(() => parsedSearch().textTerm.trim());

	// ── remote fetch ──
	createEffect(() => {
		void effectiveTypeId();
		void effectiveTextQuery();
		void effectiveKind();
		// Capture reactive values synchronously so Solid tracks them
		const exclude = new Set<string>(props.excludeIds ?? []);
		const t = window.setTimeout(() => {
			void (async () => {
				setHint("");
				const nookId = props.nookId.trim();
				if (nookId === "") return;
				const raw = draft().trim();
				if (raw === "") {
					setResults([]);
					return;
				}

				const q = effectiveTextQuery();
				const typeTerm = parsedSearch().typeTerm.trim();
				if (q === "" && typeTerm === "") {
					setResults([]);
					return;
				}

				const typeId = effectiveTypeId().trim();
				if (
					typeId !== "" &&
					props.isTypeAllowed &&
					!props.isTypeAllowed(typeId)
				) {
					setResults([]);
					const allowed = String(props.allowedTypesLabel ?? "").trim();
					setHint(
						allowed === ""
							? "This type is not allowed here."
							: `Type not allowed. Allowed: ${allowed}.`,
					);
					return;
				}

				try {
					const typeForApi = typeId !== "" ? typeId : "all";
					const qs = new URLSearchParams();
					qs.set("include_subtypes", "1");
					qs.set("limit", "50");
					if (q !== "") qs.set("q", q);
					const kind = effectiveKind().trim();
					if (kind !== "") qs.set("kind", kind);
					const res = await apiFetch(
						`/api/nooks/${nookId}/note-types/${typeForApi}/notes?${qs.toString()}`,
						{ method: "GET" },
					);
					if (!res.ok) throw new Error(`Search failed: ${res.status}`);
					const json = await res.json();
					const rawNotes = (json as { notes?: unknown })?.notes;
					const list = Array.isArray(rawNotes) ? rawNotes : [];
					const out: NoteSearchOption[] = [];
					for (const n of list) {
						if (!n || typeof n !== "object") continue;
						const obj = n as Record<string, unknown>;
						const id = typeof obj.id === "string" ? obj.id : "";
						if (id.trim() === "" || exclude.has(id)) continue;
						const optTypeId =
							typeof obj.type_id === "string" ? obj.type_id : "";
						if (props.isTypeAllowed && optTypeId.trim() !== "") {
							if (!props.isTypeAllowed(optTypeId)) continue;
						}
						const tLabel = typeLabelById().get(optTypeId.trim()) ?? "";
						const genericType =
							typeof obj.type === "string" ? String(obj.type) : "";
						out.push({
							id,
							title: typeof obj.title === "string" ? obj.title : id,
							typeId: optTypeId,
							subtitle:
								tLabel.trim() !== ""
									? tLabel
									: genericType.trim() !== ""
										? genericType
										: undefined,
						});
					}
					setResults(out);
				} catch (e) {
					setResults([]);
					setHint(e instanceof Error ? e.message : String(e));
				}
			})();
		}, 200);
		return () => window.clearTimeout(t);
	});

	// ── dropdown display (show results, not local-filtered) ──
	const displayResults = createMemo(() => results());

	const choose = (opt: NoteSearchOption) => {
		props.onChange(opt.id, opt);
		setSelectedTitle(opt.title);
		setDraft(opt.title);
		setIsOpen(false);
		setHighlightIndex(-1);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!isOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp"))
			setIsOpen(true);
		if (e.key === "Escape") {
			setIsOpen(false);
			setHighlightIndex(-1);
			return;
		}
		if (e.key === "ArrowDown") {
			e.preventDefault();
			const len = displayResults().length;
			if (len === 0) return;
			setHighlightIndex((i) => (i + 1 >= len ? 0 : i + 1));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			const len = displayResults().length;
			if (len === 0) return;
			setHighlightIndex((i) => (i - 1 < 0 ? len - 1 : i - 1));
			return;
		}
		if (e.key === "Enter") {
			const i = highlightIndex();
			const opt = i >= 0 ? displayResults()[i] : null;
			if (opt) {
				e.preventDefault();
				choose(opt);
			}
		}
	};

	// When unfocused and a value is selected, show its title
	createEffect(() => {
		if (!hasFocus() && props.value !== "" && selectedTitle() !== "") {
			setDraft(selectedTitle());
		}
		if (!hasFocus() && props.value === "") {
			setDraft("");
		}
	});

	return (
		<div
			style={{ position: "relative", width: "100%" }}
			onFocusIn={() => {
				setHasFocus(true);
			}}
			onFocusOut={(e) => {
				const next = e.relatedTarget as Node | null;
				if (!next || !e.currentTarget.contains(next)) {
					setHasFocus(false);
					window.setTimeout(() => setIsOpen(false), 120);
				}
			}}
		>
			<input
				ref={inputRef}
				type="text"
				value={draft()}
				disabled={props.disabled}
				placeholder={props.placeholder ?? "Search note…"}
				onFocus={() => {
					setHighlightIndex(-1);
					setIsOpen(true);
				}}
				onKeyDown={onKeyDown}
				onInput={(e) => {
					const next = e.currentTarget.value;
					setDraft(next);
					props.onChange("", null);
					setSelectedTitle("");
					setIsOpen(true);
				}}
				style={{ width: "100%", padding: "6px" }}
			/>

			{/* Type suggestion chips — same UX as sidebar search */}
			<Show when={typeSuggestions().length > 0}>
				<div
					style={{
						display: "flex",
						gap: "6px",
						"flex-wrap": "wrap",
						"margin-top": "4px",
						"margin-bottom": "2px",
					}}
				>
					<For each={typeSuggestions()}>
						{(s) => (
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									applyTypeSuggestion(s.fill);
								}}
								style={{
									border: "1px solid #ddd",
									"border-radius": "999px",
									padding: "2px 8px",
									background: "white",
									cursor: "pointer",
									"font-size": "12px",
								}}
								title={s.label}
							>
								{s.label}
							</button>
						)}
					</For>
				</div>
			</Show>

			<Show when={showUnknownTypeHint()}>
				<div
					style={{ color: "#b00020", "font-size": "12px", "margin-top": "2px" }}
				>
					No type matches "{parsedSearch().typeTerm}".
				</div>
			</Show>

			{/* Dropdown results */}
			<Show
				when={
					isOpen() && (displayResults().length > 0 || draft().trim() !== "")
				}
			>
				<div
					style={{
						position: "absolute",
						top: "100%",
						left: "0",
						right: "0",
						"z-index": "50",
						background: "white",
						border: "1px solid #ddd",
						"border-radius": "6px",
						"margin-top": "4px",
						"max-height": "260px",
						overflow: "auto",
					}}
				>
					<Show
						when={displayResults().length > 0}
						fallback={
							<div style={{ padding: "8px", color: "#666" }}>No results</div>
						}
					>
						<For each={displayResults()}>
							{(opt, idx) => (
								<button
									type="button"
									onMouseEnter={() => setHighlightIndex(idx())}
									onMouseDown={(e) => {
										e.preventDefault();
										choose(opt);
									}}
									style={{
										width: "100%",
										padding: "8px",
										"text-align": "left",
										border: "none",
										background:
											highlightIndex() === idx() ? "#f6f8fa" : "transparent",
										cursor: "pointer",
									}}
								>
									<div style={{ "font-weight": 600 }}>{opt.title}</div>
									<Show when={(opt.subtitle ?? "").trim() !== ""}>
										<div style={{ color: "#666", "font-size": "12px" }}>
											{opt.subtitle}
										</div>
									</Show>
								</button>
							)}
						</For>
					</Show>
				</div>
			</Show>

			<Show when={hint().trim() !== ""}>
				<div
					style={{ color: "#b00020", "font-size": "12px", "margin-top": "4px" }}
				>
					{hint()}
				</div>
			</Show>
		</div>
	);
}
