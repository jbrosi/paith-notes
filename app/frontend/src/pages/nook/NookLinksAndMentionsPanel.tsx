import { Show } from "solid-js";
import styles from "../../App.module.css";
import { login } from "../../auth/keycloak";
import type { NotePreviewController } from "./NookDefaultLayout";
import { NookMentionsPanel } from "./NookMentionsPanel";
import { NookNoteLinksPanel } from "./NookNoteLinksPanel";
import type { NookStore } from "./store";

export type NookLinksAndMentionsPanelProps = {
	store: NookStore;
	notePreview?: NotePreviewController;
};

export function NookLinksAndMentionsPanel(
	props: NookLinksAndMentionsPanelProps,
) {
	const store = () => props.store;

	return (
		<>
			<Show when={store().selectedId() !== ""}>
				<NookNoteLinksPanel store={store()} notePreview={props.notePreview} />
			</Show>

			<NookMentionsPanel
				notes={store().allNotes()}
				outgoing={store().outgoingMentions()}
				incoming={store().incomingMentions()}
				onOpenNote={(id) => void store().onNoteLinkClick(id)}
				notePreview={props.notePreview}
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
