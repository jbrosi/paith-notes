import { useLocation, useNavigate, useParams } from "@solidjs/router";
import {
	createEffect,
	createMemo,
	createSignal,
	Show,
	untrack,
} from "solid-js";
import styles from "../App.module.css";
import { NookGraphPanel } from "./nook/NookGraphPanel";
import { NookLinksPanel } from "./nook/NookLinksPanel";
import { NookMainPanel } from "./nook/NookMainPanel";
import { NookSidebar } from "./nook/NookSidebar";
import { NookStatusPanel } from "./nook/NookStatusPanel";
import { NookTypeEditPanel } from "./nook/NookTypeEditPanel";
import { createNookStore } from "./nook/store";

export default function Nook() {
	const params = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const nookId = createMemo(() => String(params.nookId ?? ""));
	const subPath = createMemo(() =>
		String((params as { path?: string }).path ?? ""),
	);
	const store = createNookStore(nookId);
	const [showMarkdown, setShowMarkdown] = createSignal<boolean>(false);
	let isApplyingUrlSelection = false;
	let lastUrlSelectRequestId = 0;

	const typeEditId = createMemo(() => {
		const p = subPath().replace(/^\/+/, "").replace(/\/+$/, "");
		if (p === "") return "";
		const parts = p.split("/").filter(Boolean);
		if (parts.length === 3 && parts[0] === "types" && parts[2] === "edit") {
			return String(parts[1] ?? "");
		}
		return "";
	});

	const showLinks = createMemo(() => {
		const p = subPath().replace(/^\/+/, "").replace(/\/+$/, "");
		return p === "links";
	});

	const noteParam = createMemo(() => {
		const sp = new URLSearchParams(location.search);
		return String(sp.get("note") ?? "").trim();
	});

	createEffect(() => {
		const id = noteParam();
		void store.allNotes();
		if (id === "") return;
		const currentSelected = untrack(() => store.selectedId());
		if (currentSelected === id) return;
		const requestId = ++lastUrlSelectRequestId;
		isApplyingUrlSelection = true;
		void (async () => {
			try {
				await store.onNoteLinkClick(id);
			} finally {
				if (requestId === lastUrlSelectRequestId) {
					isApplyingUrlSelection = false;
				}
			}
		})();
	});

	createEffect(() => {
		const id = store.selectedId().trim();
		const sp = new URLSearchParams(location.search);
		const current = String(sp.get("note") ?? "").trim();
		if (isApplyingUrlSelection) return;
		if (id === "") {
			if (current === "") return;
			sp.delete("note");
		} else {
			if (current === id) return;
			sp.set("note", id);
		}
		const next = `${location.pathname}${sp.toString() === "" ? "" : `?${sp.toString()}`}`;
		navigate(next, { replace: true });
	});

	createEffect(() => {
		const t = store.title().trim();
		if (store.selectedId().trim() === "") {
			document.title = "My Notes | Paith Notes";
			return;
		}
		document.title =
			t === "" ? "My Notes | Paith Notes" : `${t} | My Notes | Paith Notes`;
	});

	return (
		<main class={styles["container-wide"]}>
			<h1 class={styles.title}>My Notes</h1>
			<p class={styles.subtitle}>Manage your notes here</p>

			{nookId() !== "" ? (
				<p class={styles.subtitle}>
					Nook: <code>{nookId()}</code>
				</p>
			) : null}

			<div style={{ display: "flex", gap: "16px", "align-items": "stretch" }}>
				<NookSidebar
					nookId={nookId()}
					notes={store.notes()}
					notesNextCursor={store.notesNextCursor()}
					noteTypes={store.noteTypes()}
					selectedTypeId={store.selectedTypeId()}
					selectedId={store.selectedId()}
					onSelectType={(id) => store.setSelectedTypeId(id)}
					onCreateType={(i) => void store.createNoteType(i)}
					onRenameType={(t, next) => void store.renameNoteType(t, next)}
					onDeleteType={(t) => void store.deleteNoteType(t)}
					onNew={store.newNote}
					onSelect={store.selectNote}
					onLoadMoreNotes={() => void store.loadMoreNotes()}
					onSetNotesQuery={(q) => store.setNotesQuery(q)}
					onQuickUploadFile={(f) => void store.quickUploadFile(f)}
				/>

				<div style={{ flex: "1", "min-width": "0" }}>
					<Show
						when={showLinks()}
						fallback={
							<Show
								when={typeEditId() !== ""}
								fallback={
									<NookMainPanel
										store={store}
										showMarkdown={showMarkdown()}
										onToggleMarkdown={() => setShowMarkdown((v) => !v)}
									/>
								}
							>
								<NookTypeEditPanel store={store} typeId={typeEditId()} />
							</Show>
						}
					>
						<NookLinksPanel store={store} />
					</Show>

					<NookStatusPanel store={store} />
				</div>

				<NookGraphPanel store={store} />
			</div>
		</main>
	);
}
