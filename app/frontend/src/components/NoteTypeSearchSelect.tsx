import { createMemo, createSignal, For, Show } from "solid-js";

export type NoteTypeSelectItem = {
	id: string;
	label: string;
	key: string;
	parentId: string;
};

export type NoteTypeSearchSelectProps = {
	value: string;
	onChange: (id: string) => void;
	types: NoteTypeSelectItem[];
	disabled?: boolean;
	placeholder?: string;
	noneLabel?: string;
	/** When provided, applied as `class` on the trigger button (overrides inline pill styles). */
	triggerClass?: string;
};

export function NoteTypeSearchSelect(props: NoteTypeSearchSelectProps) {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	let inputRef: HTMLInputElement | undefined;

	const selectedLabel = createMemo(() => {
		const id = props.value.trim();
		if (id === "") return "";
		return props.types.find((t) => t.id === id)?.label ?? "";
	});

	const treeItems = createMemo(() => {
		const all = props.types;
		const q = query().trim().toLowerCase();

		const matches =
			q === ""
				? all
				: all.filter(
						(t) =>
							t.label.toLowerCase().includes(q) ||
							t.key.toLowerCase().includes(q),
					);

		const includeIds = new Set<string>();
		if (q === "") {
			for (const t of all) includeIds.add(t.id);
		} else {
			const byId = new Map(all.map((t) => [t.id, t]));
			for (const t of matches) {
				includeIds.add(t.id);
				let p = t.parentId.trim();
				while (p !== "") {
					includeIds.add(p);
					p = byId.get(p)?.parentId.trim() ?? "";
				}
			}
		}

		const childrenByParent = new Map<string, typeof all>();
		for (const t of all) {
			if (!includeIds.has(t.id)) continue;
			const pid = t.parentId.trim();
			const list = childrenByParent.get(pid) ?? [];
			list.push(t);
			childrenByParent.set(pid, list);
		}
		for (const list of childrenByParent.values()) {
			list.sort((a, b) => a.label.localeCompare(b.label));
		}

		const out: Array<{
			id: string;
			label: string;
			key: string;
			depth: number;
		}> = [];
		const walk = (parentId: string, depth: number) => {
			for (const t of childrenByParent.get(parentId) ?? []) {
				out.push({ id: t.id, label: t.label, key: t.key, depth });
				walk(t.id, depth + 1);
			}
		};
		walk("", 0);
		return out;
	});

	const doOpen = () => {
		if (props.disabled) return;
		setQuery("");
		setOpen(true);
		window.setTimeout(() => inputRef?.focus(), 0);
	};

	const doClose = () => {
		setOpen(false);
		setQuery("");
	};

	const choose = (id: string) => {
		props.onChange(id);
		doClose();
	};

	const triggerLabel = () =>
		selectedLabel() || props.placeholder || "(no type)";

	return (
		<div
			style={{ position: "relative", display: "inline-block" }}
			onFocusOut={(e) => {
				const next = e.relatedTarget as Node | null;
				if (!next || !e.currentTarget.contains(next)) {
					window.setTimeout(() => doClose(), 150);
				}
			}}
		>
			<Show
				when={props.triggerClass}
				fallback={
					// Default: pill/badge style used in note detail
					<button
						type="button"
						disabled={props.disabled}
						onClick={doOpen}
						style={{
							display: "inline-flex",
							"align-items": "center",
							gap: "4px",
							padding: "3px 10px",
							"border-radius": "999px",
							border: "1px solid #d0d7de",
							background: props.value.trim() !== "" ? "#f6f8fa" : "#fafafa",
							cursor: props.disabled ? "default" : "pointer",
							"font-size": "12px",
							"font-weight": "500",
							color: props.value.trim() !== "" ? "#333" : "#888",
							"line-height": "1.6",
							"white-space": "nowrap",
						}}
					>
						{triggerLabel()}
						<Show when={!props.disabled}>
							<span
								style={{
									opacity: "0.4",
									"font-size": "9px",
									"margin-left": "2px",
								}}
							>
								▾
							</span>
						</Show>
					</button>
				}
			>
				{/* triggerClass variant: used by nav, styles come from CSS module */}
				<button
					type="button"
					class={props.triggerClass}
					disabled={props.disabled}
					onClick={doOpen}
					title="Filter by type"
				>
					{triggerLabel()}
				</button>
			</Show>

			<Show when={open()}>
				<div
					style={{
						position: "absolute",
						top: "calc(100% + 4px)",
						left: "0",
						"z-index": "200",
						background: "white",
						border: "1px solid #d0d7de",
						"border-radius": "8px",
						"box-shadow": "0 8px 24px rgba(0,0,0,0.12)",
						"min-width": "200px",
						width: "max-content",
						"max-width": "320px",
						overflow: "hidden",
					}}
				>
					<div style={{ padding: "8px" }}>
						<input
							ref={inputRef}
							type="text"
							value={query()}
							placeholder="Search types…"
							onInput={(e) => setQuery(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") doClose();
							}}
							style={{
								width: "100%",
								padding: "5px 8px",
								border: "1px solid #d0d7de",
								"border-radius": "6px",
								"font-size": "13px",
								"box-sizing": "border-box",
								outline: "none",
							}}
						/>
					</div>
					<div
						style={{
							"max-height": "280px",
							overflow: "auto",
							"padding-bottom": "6px",
						}}
					>
						<button
							type="button"
							onMouseDown={(e) => {
								e.preventDefault();
								choose("");
							}}
							style={{
								width: "100%",
								padding: "6px 12px",
								"text-align": "left",
								border: "none",
								background: "transparent",
								cursor: "pointer",
								"font-size": "13px",
								color: "#888",
							}}
						>
							{props.noneLabel ?? "(none)"}
						</button>
						<Show
							when={treeItems().length > 0}
							fallback={
								<div
									style={{
										padding: "6px 12px",
										color: "#888",
										"font-size": "13px",
									}}
								>
									No types found
								</div>
							}
						>
							<For each={treeItems()}>
								{(t) => (
									<button
										type="button"
										onMouseDown={(e) => {
											e.preventDefault();
											choose(t.id);
										}}
										style={{
											width: "100%",
											padding: "6px 12px",
											"padding-left": `${12 + t.depth * 14}px`,
											"text-align": "left",
											border: "none",
											background:
												t.id === props.value ? "#f0f6ff" : "transparent",
											cursor: "pointer",
											"font-size": "13px",
											color: "#333",
											display: "flex",
											"justify-content": "space-between",
											"align-items": "center",
										}}
									>
										<span>{t.label}</span>
										<Show when={t.key.trim() !== ""}>
											<span
												style={{
													color: "#888",
													"font-size": "11px",
													"margin-left": "8px",
												}}
											>
												{t.key}
											</span>
										</Show>
									</button>
								)}
							</For>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}
