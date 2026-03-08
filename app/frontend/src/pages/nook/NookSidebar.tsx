import { A, useNavigate } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onMount,
	Show,
} from "solid-js";
import { Button } from "../../components/Button";
import {
	normalizeToken,
	parseTypedSearch,
	resolveTypeForTerm,
} from "../../noteSearch";
import type { NoteSummary, NoteType } from "./types";

export type NookSidebarProps = {
	nookId: string;
	notes: NoteSummary[];
	notesNextCursor: string;
	noteTypes: NoteType[];
	selectedTypeId: string;
	activeTypeId: string;
	selectedId: string;
	onSelectType: (typeId: string) => void;
	onCreateType: (input: {
		key: string;
		label: string;
		parentId: string;
	}) => void;
	onRenameType: (type: NoteType, nextLabel: string) => void;
	onDeleteType: (type: NoteType) => void;
	onNew: () => void;
	onSelect: (note: NoteSummary) => void;
	onLoadMoreNotes: () => void;
	onSetNotesQuery: (q: string) => void;
	onQuickUploadFile: (file: File) => void;
};

export function NookSidebar(props: NookSidebarProps) {
	const navigate = useNavigate();
	let quickUploadInput: HTMLInputElement | undefined;
	const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
	const [searchDraft, setSearchDraft] = createSignal<string>("");
	const [lastSentQuery, setLastSentQuery] = createSignal<string>("");
	const [searchHasFocus, setSearchHasFocus] = createSignal<boolean>(false);

	onMount(() => {
		const q = searchDraft();
		setLastSentQuery(q);
		props.onSetNotesQuery(q);
	});

	const effectiveActiveTypeId = createMemo(() => {
		const active = props.activeTypeId.trim();
		if (active === "") return props.selectedTypeId.trim();
		if (props.noteTypes.some((t) => t.id === active)) return active;
		return props.selectedTypeId.trim();
	});

	const isActiveType = (id: string) => {
		const tid = id.trim();
		const active = effectiveActiveTypeId();
		return tid === active;
	};

	createEffect(() => {
		const q = searchDraft();
		if (q === lastSentQuery()) return;
		const t = window.setTimeout(() => {
			setLastSentQuery(q);
			props.onSetNotesQuery(q);
		}, 200);
		return () => window.clearTimeout(t);
	});

	const parsedSearch = createMemo(() => parseTypedSearch(searchDraft()));

	const matchingType = createMemo(() => {
		const { typeTerm } = parsedSearch();
		if (typeTerm === "") return null;
		return resolveTypeForTerm(props.noteTypes, typeTerm);
	});

	const showUnknownTypeHint = createMemo(() => {
		const { typeTerm } = parsedSearch();
		if (typeTerm.trim() === "") return false;
		if (props.noteTypes.length === 0) return false;
		return matchingType() === null;
	});

	const typeSuggestions = createMemo(() => {
		const s = String(searchDraft() ?? "").trim();
		if (!searchHasFocus()) return [];
		const parsed = parsedSearch();
		const termRaw = s.includes(":") ? parsed.typeTerm : s;
		const term = normalizeToken(termRaw);
		if (term === "") return [];

		const prefix: NoteType[] = [];
		const contains: NoteType[] = [];
		for (const t of props.noteTypes) {
			const label = normalizeToken(t.label);
			const key = normalizeToken(t.key);
			if (label.startsWith(term) || key.startsWith(term)) {
				prefix.push(t);
				continue;
			}
			if (label.includes(term) || key.includes(term)) {
				contains.push(t);
			}
		}
		return [...prefix, ...contains].slice(0, 6);
	});

	const applyTypeSuggestion = (t: NoteType) => {
		setSearchDraft(`${t.key}: `);
	};

	const typesById = createMemo(() => {
		const map = new Map<string, NoteType>();
		for (const t of props.noteTypes) {
			map.set(t.id, t);
		}
		return map;
	});

	const rootTypes = createMemo(() =>
		props.noteTypes.filter((t) => t.parentId === ""),
	);
	const childrenOf = (parentId: string) =>
		props.noteTypes.filter((t) => t.parentId === parentId);

	const ensureExpanded = (id: string) => {
		setExpanded((e) => (e[id] === undefined ? { ...e, [id]: true } : e));
	};

	const toggleExpanded = (id: string) => {
		setExpanded((e) => ({ ...e, [id]: !(e[id] ?? true) }));
	};

	const promptCreateType = (parentId: string) => {
		const label = window.prompt(parentId ? "Subtype label" : "Type label");
		if (!label) return;
		const keyDefault = label
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const key = window.prompt("Type key (unique)", keyDefault);
		if (!key) return;
		props.onCreateType({ key, label, parentId });
		if (parentId) ensureExpanded(parentId);
	};

	const renderTypeNode = (t: NoteType, depth: number) => {
		const children = childrenOf(t.id);
		const isOpen = expanded()[t.id] ?? true;

		return (
			<div>
				<div
					style={{
						width: "100%",
						display: "flex",
						gap: "6px",
						"align-items": "center",
						padding: "4px 6px",
						"padding-left": `${6 + depth * 12}px`,
						"border-radius": "6px",
						background: "transparent",
						border: "1px solid transparent",
					}}
				>
					<button
						type="button"
						onClick={() => {
							props.onSelectType(t.id);
						}}
						style={{
							flex: "1",
							border: isActiveType(t.id)
								? "1px solid #007bff"
								: "1px solid transparent",
							background: isActiveType(t.id) ? "#e7f1ff" : "transparent",
							padding: "2px 4px",
							"text-align": "left",
							cursor: "pointer",
							"font-weight": isActiveType(t.id) ? 700 : 500,
							"border-radius": "6px",
						}}
						title={t.key}
					>
						{children.length > 0 ? (isOpen ? "▾ " : "▸ ") : ""}
						{t.label}
					</button>
					{children.length > 0 ? (
						<button
							type="button"
							onClick={() => toggleExpanded(t.id)}
							style={{
								border: "1px solid #ddd",
								"border-radius": "6px",
								padding: "0 6px",
								background: "white",
								cursor: "pointer",
							}}
						>
							{isOpen ? "–" : "+"}
						</button>
					) : null}
					<button
						type="button"
						onClick={() => promptCreateType(t.id)}
						style={{
							border: "1px solid #ddd",
							"border-radius": "6px",
							padding: "0 6px",
							background: "white",
							cursor: "pointer",
						}}
						title="Create subtype"
					>
						+
					</button>
					<button
						type="button"
						onClick={() => {
							const next = window.prompt("Rename type", t.label);
							if (!next) return;
							props.onRenameType(t, next);
						}}
						style={{
							border: "1px solid #ddd",
							"border-radius": "6px",
							padding: "0 6px",
							background: "white",
							cursor: "pointer",
						}}
						title="Rename"
					>
						✎
					</button>
					{t.key !== "file" ? (
						<button
							type="button"
							onClick={() => {
								navigate(`/nooks/${props.nookId}/types/${t.id}/edit`);
							}}
							style={{
								border: "1px solid #ddd",
								"border-radius": "6px",
								padding: "0 6px",
								background: "white",
								cursor: "pointer",
							}}
							title="Edit"
						>
							⚙
						</button>
					) : null}
					<button
						type="button"
						onClick={() => {
							if (!window.confirm(`Delete type "${t.label}"?`)) return;
							props.onDeleteType(t);
						}}
						style={{
							border: "1px solid #ddd",
							"border-radius": "6px",
							padding: "0 6px",
							background: "white",
							cursor: "pointer",
						}}
						title="Delete"
					>
						🗑
					</button>
				</div>
				<Show when={children.length > 0 && isOpen}>
					<For each={children}>{(c) => renderTypeNode(c, depth + 1)}</For>
				</Show>
			</div>
		);
	};

	const noteTypeLabel = (note: NoteSummary) => {
		const tid = String(note.typeId ?? "").trim();
		if (tid === "") return "";
		const t = typesById().get(tid);
		return t ? t.label : "";
	};

	return (
		<div
			style={{
				width: "540px",
				"flex-shrink": "0",
				"border-right": "1px solid #eee",
				padding: "0 16px 0 0",
			}}
		>
			<div style={{ display: "flex", gap: "12px" }}>
				<div style={{ width: "260px", "flex-shrink": "0" }}>
					<div
						style={{
							display: "flex",
							"justify-content": "space-between",
							"align-items": "center",
							"margin-bottom": "6px",
						}}
					>
						<div style={{ "font-weight": 600 }}>Types</div>
						<div
							style={{ display: "flex", gap: "8px", "align-items": "center" }}
						>
							<Button
								variant="secondary"
								onClick={() => navigate(`/nooks/${props.nookId}/links`)}
							>
								Links
							</Button>
							<Button variant="secondary" onClick={() => promptCreateType("")}>
								New type
							</Button>
						</div>
					</div>
					<button
						type="button"
						onClick={() => props.onSelectType("")}
						style={{
							width: "100%",
							padding: "6px",
							"text-align": "left",
							"border-radius": "6px",
							border:
								effectiveActiveTypeId() === ""
									? "1px solid #007bff"
									: "1px solid #ddd",
							background: effectiveActiveTypeId() === "" ? "#e7f1ff" : "white",
							cursor: "pointer",
							"margin-bottom": "6px",
							"font-weight": effectiveActiveTypeId() === "" ? 700 : 500,
						}}
					>
						All notes
					</button>
					<div>
						<For each={rootTypes()}>{(t) => renderTypeNode(t, 0)}</For>
					</div>
				</div>

				<div style={{ width: "260px", "flex-shrink": "0" }}>
					<div
						style={{
							display: "flex",
							"justify-content": "space-between",
							"align-items": "center",
							"margin-bottom": "12px",
						}}
					>
						<div style={{ "font-weight": "600" }}>Notes</div>
						<div
							style={{ display: "flex", gap: "8px", "align-items": "center" }}
						>
							<input
								ref={quickUploadInput}
								type="file"
								style={{ display: "none" }}
								onChange={(e) => {
									const f = e.currentTarget.files?.[0];
									e.currentTarget.value = "";
									if (f) props.onQuickUploadFile(f);
								}}
							/>
							<Button
								variant="secondary"
								onClick={() => quickUploadInput?.click()}
							>
								Upload file
							</Button>
							<Button onClick={props.onNew} variant="secondary">
								New
							</Button>
						</div>
					</div>

					<input
						type="text"
						value={searchDraft()}
						placeholder="Search…"
						onInput={(e) => setSearchDraft(e.currentTarget.value)}
						onFocus={() => setSearchHasFocus(true)}
						onBlur={() => {
							window.setTimeout(() => setSearchHasFocus(false), 150);
						}}
						style={{
							width: "100%",
							padding: "6px",
							"border-radius": "6px",
							border: "1px solid #ddd",
							"margin-bottom": "8px",
						}}
					/>
					<Show when={typeSuggestions().length > 0}>
						<div
							style={{
								position: "relative",
								"margin-top": "-6px",
								"margin-bottom": "8px",
							}}
						>
							<div
								style={{
									display: "flex",
									gap: "6px",
									"flex-wrap": "wrap",
								}}
							>
								<For each={typeSuggestions()}>
									{(t) => (
										<button
											type="button"
											onClick={() => applyTypeSuggestion(t)}
											style={{
												border: "1px solid #ddd",
												"border-radius": "999px",
												padding: "2px 8px",
												background: "white",
												cursor: "pointer",
												"font-size": "12px",
											}}
											title={t.label}
										>
											{t.key}:
										</button>
									)}
								</For>
							</div>
						</div>
					</Show>
					<Show when={showUnknownTypeHint()}>
						<div
							style={{
								color: "#b00020",
								"font-size": "12px",
								"margin-bottom": "8px",
							}}
						>
							No type matches “{parsedSearch().typeTerm}”.
						</div>
					</Show>

					<div>
						<For each={props.notes}>
							{(note) => (
								<A
									href={`/nooks/${props.nookId}?note=${encodeURIComponent(note.id)}`}
									onClick={(e) => {
										if (
											e.button !== 0 ||
											e.ctrlKey ||
											e.metaKey ||
											e.shiftKey ||
											e.altKey
										) {
											return;
										}
										props.onSelect(note);
									}}
									style={{
										width: "100%",
										padding: "8px",
										"text-align": "left",
										"border-radius": "6px",
										border: "1px solid #ddd",
										background:
											note.id === props.selectedId ? "#f6f8fa" : "white",
										"margin-bottom": "8px",
										cursor: "pointer",
										display: "block",
										"text-decoration": "none",
										color: "inherit",
									}}
								>
									<div
										style={{
											display: "flex",
											gap: "8px",
											"align-items": "center",
											"justify-content": "space-between",
										}}
									>
										<div
											style={{
												display: "flex",
												gap: "8px",
												"align-items": "center",
											}}
										>
											<div style={{ "font-weight": "600" }}>{note.title}</div>
											{note.type === "file" ? (
												<span
													style={{
														"font-size": "12px",
														padding: "2px 6px",
														"border-radius": "999px",
														border: "1px solid #c9def7",
														background: "#eef5ff",
														color: "#1f5fbf",
													}}
												>
													File
												</span>
											) : null}
											{noteTypeLabel(note) !== "" ? (
												<span
													style={{
														"font-size": "12px",
														padding: "2px 6px",
														"border-radius": "999px",
														border: "1px solid #ddd",
														background: "#fafafa",
														color: "#444",
													}}
												>
													{noteTypeLabel(note)}
												</span>
											) : null}
										</div>
										<div
											style={{
												display: "flex",
												gap: "6px",
												"align-items": "center",
												color: "#666",
												"font-size": "12px",
											}}
										>
											<div>
												links{" "}
												{note.incomingLinksCount + note.outgoingLinksCount}
											</div>
											<div>in {note.incomingMentionsCount}</div>
											<div>out {note.outgoingMentionsCount}</div>
										</div>
									</div>
								</A>
							)}
						</For>
					</div>

					<Show when={props.notesNextCursor.trim() !== ""}>
						<Button variant="secondary" onClick={() => props.onLoadMoreNotes()}>
							Load more
						</Button>
					</Show>
				</div>
			</div>
		</div>
	);
}
