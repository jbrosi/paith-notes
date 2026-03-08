import { createMemo, createSignal, For, Show } from "solid-js";
import type { NookStore } from "../../pages/nook/store";
import styles from "../Nav.module.css";

export type NookNotesSearchDropdownProps = {
	store: NookStore | null;
};

export function NookNotesSearchDropdown(props: NookNotesSearchDropdownProps) {
	const storeReady = createMemo(() => props.store !== null);
	const store = () => props.store;

	const [open, setOpen] = createSignal<boolean>(false);
	let closeTimeout: number | undefined;

	const noteResults = createMemo(() => {
		const s = store();
		if (!s) return [];
		return s.notes().slice(0, 12);
	});

	return (
		<div class={styles.dropdown}>
			<input
				type="text"
				disabled={!storeReady()}
				value={store()?.notesQuery() ?? ""}
				placeholder="Search notes…"
				onInput={(e) => store()?.setNotesQuery(e.currentTarget.value)}
				onFocus={() => {
					if (closeTimeout !== undefined) {
						window.clearTimeout(closeTimeout);
						closeTimeout = undefined;
					}
					setOpen(true);
				}}
				onBlur={() => {
					closeTimeout = window.setTimeout(() => setOpen(false), 150);
				}}
				style={{
					width: "260px",
					padding: "6px",
					"border-radius": "6px",
					border: "1px solid #ddd",
				}}
			/>
			<Show when={open()}>
				<div class={styles["dropdown-menu"]}>
					<div class={styles["dropdown-list"]}>
						<For each={noteResults()}>
							{(n) => (
								<button
									type="button"
									class={styles["dropdown-item"]}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										void store()?.onNoteLinkClick(n.id);
										setOpen(false);
									}}
								>
									<span>{n.title}</span>
									<span class={styles["dropdown-meta"]}>{n.type}</span>
								</button>
							)}
						</For>
					</div>
				</div>
			</Show>
		</div>
	);
}
