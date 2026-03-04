import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

export type NoteSearchOption = {
	id: string;
	title: string;
	subtitle?: string;
	typeId?: string;
};

export type NoteSearchSelectProps = {
	value: string;
	options: NoteSearchOption[];
	onChange: (nextId: string, option: NoteSearchOption | null) => void;
	placeholder?: string;
	disabled?: boolean;
	excludeIds?: string[];
	maxResults?: number;
	typeNodes?: Array<{ id: string; parentId: string }>;
	typeFilter?: {
		value: string;
		onChange: (nextTypeId: string) => void;
		options: Array<{ id: string; label: string }>;
		placeholder?: string;
		disabled?: boolean;
	};
	filters?: {
		typeId?: string;
		includeSubtypes?: boolean;
	};
};

export function NoteSearchSelect(props: NoteSearchSelectProps) {
	const [draft, setDraft] = createSignal<string>("");
	const [isOpen, setIsOpen] = createSignal<boolean>(false);
	const [highlightIndex, setHighlightIndex] = createSignal<number>(-1);
	const [hasFocus, setHasFocus] = createSignal<boolean>(false);
	let closeTimeout: number | undefined;

	const excludeSet = createMemo(() => {
		const s = new Set<string>();
		for (const id of props.excludeIds ?? []) s.add(id);
		return s;
	});

	const parentByTypeId = createMemo(() => {
		const m = new Map<string, string>();
		for (const t of props.typeNodes ?? []) {
			m.set(t.id, t.parentId);
		}
		return m;
	});

	const isSameOrDescendant = (childId: string, ancestorId: string) => {
		const child = childId.trim();
		const ancestor = ancestorId.trim();
		if (child === "" || ancestor === "") return false;
		if (child === ancestor) return true;
		let cur = child;
		const parentMap = parentByTypeId();
		for (let i = 0; i < 64; i++) {
			const p = parentMap.get(cur) ?? "";
			if (p === "") return false;
			if (p === ancestor) return true;
			cur = p;
		}
		return false;
	};

	const selected = createMemo(
		() => props.options.find((o) => o.id === props.value) ?? null,
	);

	createEffect(() => {
		if (hasFocus()) return;
		const s = selected();
		if (s) {
			setDraft(s.title);
			return;
		}
		if (props.value === "") setDraft("");
	});

	const filtered = createMemo<NoteSearchOption[]>(() => {
		const q = draft().trim().toLowerCase();
		const max = props.maxResults ?? 8;
		const filterTypeId = String(props.filters?.typeId ?? "").trim();
		const includeSubtypes = props.filters?.includeSubtypes ?? true;
		const out: NoteSearchOption[] = [];
		for (const o of props.options) {
			if (excludeSet().has(o.id)) continue;
			if (filterTypeId !== "") {
				const optionTypeId = String(o.typeId ?? "").trim();
				if (optionTypeId === "") continue;
				if (includeSubtypes) {
					if (
						optionTypeId !== filterTypeId &&
						!isSameOrDescendant(optionTypeId, filterTypeId)
					) {
						continue;
					}
				} else {
					if (optionTypeId !== filterTypeId) continue;
				}
			}
			if (q !== "") {
				const h = `${o.title} ${o.subtitle ?? ""}`.toLowerCase();
				if (!h.includes(q)) continue;
			}
			out.push(o);
			if (out.length >= max) break;
		}
		return out;
	});

	const open = () => {
		if (props.disabled) return;
		if (closeTimeout !== undefined) window.clearTimeout(closeTimeout);
		setIsOpen(true);
	};

	const close = () => {
		if (closeTimeout !== undefined) window.clearTimeout(closeTimeout);
		closeTimeout = window.setTimeout(() => {
			setIsOpen(false);
			setHighlightIndex(-1);
		}, 120);
	};

	const choose = (opt: NoteSearchOption) => {
		props.onChange(opt.id, opt);
		setDraft(opt.title);
		setIsOpen(false);
		setHighlightIndex(-1);
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (!isOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
			open();
		}

		if (e.key === "Escape") {
			setIsOpen(false);
			setHighlightIndex(-1);
			return;
		}

		if (e.key === "ArrowDown") {
			e.preventDefault();
			const len = filtered().length;
			if (len === 0) return;
			setHighlightIndex((i) => {
				const next = i + 1;
				return next >= len ? 0 : next;
			});
			return;
		}

		if (e.key === "ArrowUp") {
			e.preventDefault();
			const len = filtered().length;
			if (len === 0) return;
			setHighlightIndex((i) => {
				const next = i - 1;
				return next < 0 ? len - 1 : next;
			});
			return;
		}

		if (e.key === "Enter") {
			const i = highlightIndex();
			const opt = i >= 0 ? filtered()[i] : null;
			if (opt) {
				e.preventDefault();
				choose(opt);
			}
		}
	};

	return (
		<div
			style={{ position: "relative", width: "100%" }}
			onFocusIn={() => setHasFocus(true)}
			onFocusOut={(e) => {
				const next = e.relatedTarget as Node | null;
				if (!next || !e.currentTarget.contains(next)) {
					setHasFocus(false);
					close();
				}
			}}
		>
			<input
				type="text"
				value={draft()}
				disabled={props.disabled}
				placeholder={props.placeholder ?? "Search note…"}
				onFocus={() => {
					setHighlightIndex(-1);
					open();
				}}
				onKeyDown={onKeyDown}
				onInput={(e) => {
					setDraft(e.currentTarget.value);
					props.onChange("", null);
					open();
				}}
				style={{ width: "100%", padding: "6px" }}
			/>
			<Show when={isOpen() && (filtered().length > 0 || draft().trim() !== "")}>
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
					<Show when={props.typeFilter} keyed>
						{(tf) => (
							<div
								style={{ padding: "8px", "border-bottom": "1px solid #eee" }}
							>
								<select
									value={tf.value}
									onChange={(e) => tf.onChange(e.currentTarget.value)}
									disabled={props.disabled || tf.disabled}
									aria-label="Type filter"
									style={{ width: "100%", padding: "6px" }}
								>
									<option value="">{tf.placeholder ?? "All types"}</option>
									{tf.options.map((o) => (
										<option value={o.id}>{o.label}</option>
									))}
								</select>
							</div>
						)}
					</Show>
					<Show
						when={filtered().length > 0}
						fallback={
							<div style={{ padding: "8px", color: "#666" }}>No results</div>
						}
					>
						<For each={filtered()}>
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
		</div>
	);
}
