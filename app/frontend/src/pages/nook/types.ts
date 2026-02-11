import { z } from "zod";

const NoteApiSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		content: z.string(),
		outgoing_mentions_count: z.number().int().optional(),
		incoming_mentions_count: z.number().int().optional(),
		type: z.enum(["anything", "person", "file"]).optional(),
		properties: z.record(z.string(), z.unknown()).optional(),
		former_properties: z.record(z.string(), z.unknown()).optional(),
		created_at: z.string().optional(),
	})
	.transform((n) => ({
		id: n.id,
		title: n.title,
		content: n.content,
		outgoingMentionsCount: n.outgoing_mentions_count ?? 0,
		incomingMentionsCount: n.incoming_mentions_count ?? 0,
		type: n.type ?? "anything",
		properties: n.properties ?? {},
		formerProperties: n.former_properties ?? {},
		createdAt: n.created_at,
	}));

export const NotesListResponseSchema = z
	.object({
		notes: z.array(NoteApiSchema),
	})
	.transform((r) => ({
		notes: r.notes,
	}));

export const NoteResponseSchema = z
	.object({
		note: NoteApiSchema,
	})
	.transform((r) => ({
		note: r.note,
	}));

const MentionApiSchema = z
	.object({
		note_id: z.string(),
		note_title: z.string(),
		link_title: z.string(),
		position: z.number().int(),
	})
	.transform((m) => ({
		noteId: m.note_id,
		noteTitle: m.note_title,
		linkTitle: m.link_title,
		position: m.position,
	}));

export const MentionsResponseSchema = z
	.object({
		outgoing: z.array(MentionApiSchema),
		incoming: z.array(MentionApiSchema),
	})
	.transform((r) => ({
		outgoing: r.outgoing,
		incoming: r.incoming,
	}));

export type Note = z.infer<typeof NoteApiSchema>;
export type Mention = z.infer<typeof MentionApiSchema>;
export type NotesListResponse = z.infer<typeof NotesListResponseSchema>;
export type NoteResponse = z.infer<typeof NoteResponseSchema>;
export type MentionsResponse = z.infer<typeof MentionsResponseSchema>;
