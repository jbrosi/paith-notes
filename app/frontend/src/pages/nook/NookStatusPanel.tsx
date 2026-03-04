import { Show } from "solid-js";
import styles from "../../App.module.css";
import { login } from "../../auth/keycloak";
import { NookMentionsPanel } from "./NookMentionsPanel";
import type { NookStore } from "./store";

export type NookStatusPanelProps = {
	store: NookStore;
};

export function NookStatusPanel(props: NookStatusPanelProps) {
	const store = () => props.store;

	return (
		<>
			<NookMentionsPanel
				notes={store().allNotes()}
				outgoing={store().outgoingMentions()}
				incoming={store().incomingMentions()}
				onOpenNote={(id) => void store().onNoteLinkClick(id)}
			/>

			<Show when={store().needsLogin()}>
				<div style={{ "margin-top": "1rem" }}>
					<p class={styles.subtitle}>
						Your session timed out. Please log in again.
					</p>
					<button type="button" onClick={() => login()}>
						Log in
					</button>
				</div>
			</Show>

			<Show when={store().error() !== ""}>
				<pre class={styles.error}>{store().error()}</pre>
			</Show>
		</>
	);
}
