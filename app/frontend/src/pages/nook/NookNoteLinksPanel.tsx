import { createEffect, createSignal, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { AddLinkForm } from "./components/AddLinkForm";
import { LinkList } from "./components/LinkList";
import css from "./NookNoteLinksPanel.module.css";
import type { NookStore } from "./store";
import { type NoteLink, NoteLinksListResponseSchema } from "./types";

export type NookNoteLinksPanelProps = {
	store: NookStore;
};

export function NookNoteLinksPanel(props: NookNoteLinksPanelProps) {
	const store = () => props.store;
	const nookId = () => store().nookId();
	const noteId = () => store().selectedId();

	const [_loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal("");
	const [links, setLinks] = createSignal<NoteLink[]>([]);
	const [showAddForm, setShowAddForm] = createSignal(false);

	const loadLinks = async () => {
		if (nookId().trim() === "") return;
		if (noteId().trim() === "") {
			setLinks([]);
			return;
		}
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links?direction=both&depth=1`,
				{ method: "GET" },
			);
			if (!res.ok)
				throw new Error(
					`Failed to load links: ${res.status} ${res.statusText}`,
				);
			const body = NoteLinksListResponseSchema.parse(await res.json());
			setLinks(body.links);
		} catch (e) {
			setLinks([]);
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const deleteLink = async (linkId: string) => {
		if (!nookId().trim() || !noteId().trim() || !linkId.trim()) return;
		setLoading(true);
		setError("");
		try {
			const res = await apiFetch(
				`/api/nooks/${nookId()}/notes/${noteId()}/links/${linkId.trim()}`,
				{ method: "DELETE" },
			);
			if (!res.ok)
				throw new Error(
					`Failed to delete link: ${res.status} ${res.statusText}`,
				);
			setLinks(links().filter((l) => l.id !== linkId));
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	createEffect(() => void loadLinks());
	createEffect(() => {
		void noteId();
		setShowAddForm(false);
	});

	return (
		<Show when={noteId().trim() !== ""}>
			<div class={css.container}>
				<div class={css.header}>
					<div class={css.title}>Links</div>
					<Show when={store().canWrite()}>
						<button
							type="button"
							onClick={() => setShowAddForm((v) => !v)}
							style={{
								background: "none",
								border: "none",
								color: "var(--link-color, #0066cc)",
								cursor: "pointer",
								"font-size": "0.75rem",
								padding: "0",
							}}
						>
							{showAddForm() ? "Cancel" : "+ Add"}
						</button>
					</Show>
				</div>

				<Show when={error() !== ""}>
					<pre class={css.error}>{error()}</pre>
				</Show>

				<Show when={showAddForm()}>
					<AddLinkForm
						store={store()}
						nookId={nookId()}
						noteId={noteId()}
						onLinkCreated={(link) => {
							setLinks([link, ...links()]);
							setShowAddForm(false);
						}}
						onError={setError}
					/>
				</Show>

				<LinkList
					links={links()}
					noteId={noteId()}
					isEditing={store().canWrite()}
					onOpenNote={(id) => void store().onNoteLinkClick(id)}
					onDeleteLink={(id) => void deleteLink(id)}
				/>
			</div>
		</Show>
	);
}
