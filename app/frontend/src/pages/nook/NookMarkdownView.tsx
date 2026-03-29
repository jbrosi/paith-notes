import styles from "./NookMarkdownView.module.css";
import type { NookStore } from "./store";

export type NookMarkdownViewProps = {
	store: NookStore;
};

export function NookMarkdownView(props: NookMarkdownViewProps) {
	return (
		<div class={styles.container}>
			<textarea
				readOnly
				value={props.store.content()}
				class={styles.textarea}
			/>
		</div>
	);
}
