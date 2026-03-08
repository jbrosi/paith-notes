import { createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../Button";
import styles from "../Nav.module.css";
import type { NookStore } from "../../pages/nook/store";

export type NookTypeFilterDropdownProps = {
	store: NookStore | null;
};

export function NookTypeFilterDropdown(props: NookTypeFilterDropdownProps) {
	const storeReady = createMemo(() => props.store !== null);
	const store = () => props.store;

	const [open, setOpen] = createSignal<boolean>(false);
	const [typeSearch, setTypeSearch] = createSignal<string>("");

	const currentTypeLabel = createMemo(() => {
		const s = store();
		if (!s) return "Types";
		const active = s.activeTypeId().trim();
		if (active === "") return "All types";
		const t = s.noteTypes().find((x) => x.id === active) ?? null;
		return t ? t.label : "Types";
	});

	const filteredTypes = createMemo(() => {
		const s = store();
		if (!s) return [];
		const q = typeSearch().trim().toLowerCase();
		const all = s.noteTypes();
		if (q === "") return all;
		return all.filter((t) => {
			const label = String(t.label ?? "").toLowerCase();
			const key = String(t.key ?? "").toLowerCase();
			return label.includes(q) || key.includes(q);
		});
	});

	const typeTreeItems = createMemo(() => {
		const s = store();
		if (!s) return [] as Array<{ id: string; label: string; key: string; depth: number }>;
		const all = s.noteTypes();
		const q = typeSearch().trim().toLowerCase();
		const matches = filteredTypes();
		const includeAll = q === "";
		const includeIds = new Set<string>();
		if (includeAll) {
			for (const t of all) includeIds.add(t.id);
		} else {
			for (const t of matches) includeIds.add(t.id);
			const byId = new Map(all.map((t) => [t.id, t] as const));
			for (const t of matches) {
				let p = String(t.parentId ?? "").trim();
				while (p !== "") {
					includeIds.add(p);
					p = String(byId.get(p)?.parentId ?? "").trim();
				}
			}
		}

		const childrenByParent = new Map<string, typeof all>();
		for (const t of all) {
			if (!includeIds.has(t.id)) continue;
			const pid = String(t.parentId ?? "").trim();
			const list = childrenByParent.get(pid) ?? [];
			list.push(t);
			childrenByParent.set(pid, list);
		}
		for (const list of childrenByParent.values()) {
			list.sort((a, b) => String(a.label).localeCompare(String(b.label)));
		}

		const out: Array<{ id: string; label: string; key: string; depth: number }> = [];
		const walk = (parentId: string, depth: number) => {
			const kids = childrenByParent.get(parentId) ?? [];
			for (const t of kids) {
				out.push({ id: t.id, label: t.label, key: t.key, depth });
				walk(t.id, depth + 1);
			}
		};
		walk("", 0);
		return out;
	});

	return (
		<div class={styles.dropdown}>
			<button
				type="button"
				class={styles["dropdown-toggle"]}
				disabled={!storeReady()}
				onClick={() => {
					const next = !open();
					setOpen(next);
					if (next) setTypeSearch("");
				}}
				title="Filter by type"
			>
				{currentTypeLabel()}
			</button>

			<Show when={open()}>
				<div class={styles["dropdown-menu"]}>
					<div class={styles["dropdown-header"]}>
						<input
							type="text"
							value={typeSearch()}
							placeholder="Search types…"
							onInput={(e) => setTypeSearch(e.currentTarget.value)}
							style={{
								width: "100%",
								padding: "6px",
								"border-radius": "6px",
								border: "1px solid #ddd",
							}}
						/>
						<Button variant="secondary" size="small" onClick={() => setOpen(false)}>
							Close
						</Button>
					</div>

					<div class={styles["dropdown-list"]}>
						<button
							type="button"
							class={styles["dropdown-item"]}
							onClick={() => {
								store()?.setSelectedTypeId("");
								setOpen(false);
							}}
						>
							<span>All types</span>
							<span class={styles["dropdown-meta"]} />
						</button>

						<For each={typeTreeItems()}>
							{(t) => (
								<button
									type="button"
									class={styles["dropdown-item"]}
									onClick={() => {
										store()?.setSelectedTypeId(t.id);
										setOpen(false);
									}}
									style={{
										"padding-left": `${8 + t.depth * 12}px`,
									}}
								>
									<span>{t.label}</span>
									<span class={styles["dropdown-meta"]}>{t.key}</span>
								</button>
							)}
						</For>
					</div>
				</div>
			</Show>
		</div>
	);
}
