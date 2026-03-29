import { createMemo, createSignal, For, Show } from "solid-js";
import styles from "./NoteTypeSearchSelect.module.css";

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
			class={styles.wrapper}
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
					<button
						type="button"
						disabled={props.disabled}
						onClick={doOpen}
						class={`${styles.triggerPill} ${props.value.trim() === "" ? styles.triggerPillEmpty : ""}`}
					>
						{triggerLabel()}
						<Show when={!props.disabled}>
							<span class={styles.triggerArrow}>▾</span>
						</Show>
					</button>
				}
			>
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
				<div class={styles.dropdown}>
					<div class={styles.searchBox}>
						<input
							ref={inputRef}
							type="text"
							value={query()}
							placeholder="Search types..."
							onInput={(e) => setQuery(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") doClose();
							}}
							class={styles.searchInput}
						/>
					</div>
					<div class={styles.list}>
						<button
							type="button"
							class={styles.noneOption}
							onMouseDown={(e) => {
								e.preventDefault();
								choose("");
							}}
						>
							{props.noneLabel ?? "(none)"}
						</button>
						<Show
							when={treeItems().length > 0}
							fallback={<div class={styles.emptyText}>No types found</div>}
						>
							<For each={treeItems()}>
								{(t) => (
									<button
										type="button"
										onMouseDown={(e) => {
											e.preventDefault();
											choose(t.id);
										}}
										class={`${styles.typeOption} ${t.id === props.value ? styles.typeOptionActive : ""}`}
										style={{ "padding-left": `${12 + t.depth * 14}px` }}
									>
										<span>{t.label}</span>
										<Show when={t.key.trim() !== ""}>
											<span class={styles.typeKey}>{t.key}</span>
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
