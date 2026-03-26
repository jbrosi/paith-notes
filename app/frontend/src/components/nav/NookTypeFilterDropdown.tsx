import { createMemo } from "solid-js";
import type { NookStore } from "../../pages/nook/store";
import styles from "../Nav.module.css";
import { NoteTypeSearchSelect } from "../NoteTypeSearchSelect";

export type NookTypeFilterDropdownProps = {
	store: NookStore | null;
};

export function NookTypeFilterDropdown(props: NookTypeFilterDropdownProps) {
	const store = () => props.store;

	const types = createMemo(() => store()?.noteTypes() ?? []);
	const value = createMemo(() => store()?.activeTypeId() ?? "");

	return (
		<div class={styles.dropdown}>
			<NoteTypeSearchSelect
				value={value()}
				onChange={(id) => store()?.setSelectedTypeId(id)}
				types={types()}
				disabled={store() === null}
				placeholder="All types"
				noneLabel="All types"
				triggerClass={styles["dropdown-toggle"]}
			/>
		</div>
	);
}
