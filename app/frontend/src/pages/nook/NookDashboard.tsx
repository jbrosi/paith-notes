import { createMemo, Show } from "solid-js";
import { Button } from "../../components/Button";
import styles from "./NookDashboard.module.css";
import type { NookStore } from "./store";

export type NookDashboardProps = {
	store: NookStore;
};

export function NookDashboard(props: NookDashboardProps) {
	const noteCount = createMemo(() => props.store.allNotes().length);
	const typeCount = createMemo(() => props.store.noteTypes().length);

	return (
		<div class={styles.container}>
			<div class={styles.welcome}>
				<h2 class={styles.title}>Welcome to your nook</h2>
				<p class={styles.subtitle}>
					Search for a note above or create a new one to get started.
				</p>
			</div>

			<div class={styles.stats}>
				<div class={styles.statCard}>
					<div class={styles.statValue}>{noteCount()}</div>
					<div class={styles.statLabel}>Notes</div>
				</div>
				<div class={styles.statCard}>
					<div class={styles.statValue}>{typeCount()}</div>
					<div class={styles.statLabel}>Types</div>
				</div>
			</div>

			<Show when={noteCount() === 0}>
				<div class={styles.emptyAction}>
					<Button onClick={props.store.newNote}>Create your first note</Button>
				</div>
			</Show>
		</div>
	);
}
