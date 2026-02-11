export type Note = {
	id: string;
	title: string;
	content: string;
	created_at?: string;
};

export type Mention = {
	note_id: string;
	note_title: string;
	link_title: string;
	position: number;
};

export type NotesListResponse = {
	notes: Note[];
};

export type NoteResponse = {
	note: Note;
};

export type MentionsResponse = {
	outgoing: Mention[];
	incoming: Mention[];
};
