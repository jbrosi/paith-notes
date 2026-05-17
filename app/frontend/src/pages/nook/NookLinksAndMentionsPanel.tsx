import { Show } from "solid-js";
import { login } from "../../auth/keycloak";
import { NookMentionsPanel } from "./NookMentionsPanel";
import { NookNoteLinksPanel } from "./NookNoteLinksPanel";
import type { NookStore } from "./store";

export type NookLinksAndMentionsPanelProps = {
	store: NookStore;
};

export function NookLinksAndMentionsPanel(
	props: NookLinksAndMentionsPanelProps,
) {
	const store = () => props.store;

	const hasMentions = () =>
		store().outgoingMentions().length > 0 || store().incomingMentions().length > 0;

	return (
		<>
			<Show when={store().selectedId() !== ""}>
				<hr style={{ border: "none", "border-top": "1px solid var(--color-border-light, #eee)", margin: "0.75rem 0" }} />
				<NookNoteLinksPanel store={store()} />
			</Show>

			<Show when={hasMentions()}>
				<hr style={{ border: "none", "border-top": "1px solid var(--color-border-light, #eee)", margin: "0.75rem 0" }} />
				<NookMentionsPanel
					nookId={store().nookId()}
					notes={store().allNotes()}
					outgoing={store().outgoingMentions()}
					incoming={store().incomingMentions()}
					onOpenNote={(id) => void store().onNoteLinkClick(id)}
				/>
			</Show>

			<Show when={store().needsLogin()}>
				<div style={{ "margin-top": "1rem" }}>
					<p style={{ color: "var(--color-text-muted)", "font-size": "0.8rem" }}>
						Your session timed out. Please log in again.
					</p>
					<button type="button" onClick={() => login()}>
						Log in
					</button>
				</div>
			</Show>

			<Show when={store().error() !== ""}>
				<pre style={{ color: "var(--color-danger)", "white-space": "pre-wrap", "font-size": "0.75rem" }}>{store().error()}</pre>
			</Show>
		</>
	);
}
