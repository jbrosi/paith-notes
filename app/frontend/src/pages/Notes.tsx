import { createSignal, For } from "solid-js";
import styles from "../App.module.css";
import { Button } from "../components/Button";
import notesStyles from "./Notes.module.css";

type Note = {
	id: number;
	title: string;
	content: string;
};

export default function Notes() {
	const [notes, setNotes] = createSignal<Note[]>([
		{ id: 1, title: "First Note", content: "This is my first note" },
		{ id: 2, title: "Second Note", content: "This is my second note" },
	]);

	const addNote = () => {
		const newNote: Note = {
			id: Date.now(),
			title: `Note ${notes().length + 1}`,
			content: "New note content",
		};
		setNotes([...notes(), newNote]);
	};

	return (
		<main class={styles.container}>
			<h1 class={styles.title}>My Notes</h1>
			<p class={styles.subtitle}>Manage your notes here</p>

			<div class={notesStyles["add-note-container"]}>
				<Button onClick={addNote}>Add Note</Button>
			</div>

			<div>
				<For each={notes()}>
					{(note) => (
						<div class={notesStyles["note-card"]}>
							<h3>{note.title}</h3>
							<p>{note.content}</p>
						</div>
					)}
				</For>
			</div>
		</main>
	);
}
