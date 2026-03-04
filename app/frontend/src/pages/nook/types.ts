import { z } from "zod";

const NoteSummaryApiSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		type_id: z.string().optional(),
		outgoing_mentions_count: z.number().int().optional(),
		incoming_mentions_count: z.number().int().optional(),
		outgoing_links_count: z.number().int().optional(),
		incoming_links_count: z.number().int().optional(),
		type: z.enum(["anything", "person", "file"]).optional(),
		created_at: z.string().optional(),
	})
	.transform((n) => ({
		id: n.id,
		title: n.title,
		typeId: n.type_id ?? "",
		outgoingMentionsCount: n.outgoing_mentions_count ?? 0,
		incomingMentionsCount: n.incoming_mentions_count ?? 0,
		outgoingLinksCount: n.outgoing_links_count ?? 0,
		incomingLinksCount: n.incoming_links_count ?? 0,
		type: n.type ?? "anything",
		createdAt: n.created_at,
	}));

const NoteDetailApiSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		content: z.string(),
		type_id: z.string().optional(),
		type: z.enum(["anything", "person", "file"]).optional(),
		properties: z.record(z.string(), z.unknown()).optional(),
		former_properties: z.record(z.string(), z.unknown()).optional(),
		created_at: z.string().optional(),
	})
	.transform((n) => ({
		id: n.id,
		title: n.title,
		content: n.content,
		typeId: n.type_id ?? "",
		type: n.type ?? "anything",
		properties: n.properties ?? {},
		formerProperties: n.former_properties ?? {},
		createdAt: n.created_at,
	}));

export const NotesListResponseSchema = z
	.object({
		notes: z.array(NoteSummaryApiSchema),
	})
	.transform((r) => ({
		notes: r.notes,
	}));

export const NoteTypeNotesResponseSchema = z
	.object({
		notes: z.array(NoteSummaryApiSchema),
		next_cursor: z.string().optional(),
	})
	.transform((r) => ({
		notes: r.notes,
		nextCursor: r.next_cursor ?? "",
	}));

export const NoteResponseSchema = z
	.object({
		note: NoteDetailApiSchema,
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

const NoteTypeApiSchema = z
	.object({
		id: z.string(),
		nook_id: z.string(),
		key: z.string(),
		label: z.string(),
		description: z.string().optional(),
		parent_id: z.string().optional(),
		applies_to_files: z.boolean().optional(),
		applies_to_notes: z.boolean().optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
	})
	.transform((t) => ({
		id: t.id,
		nookId: t.nook_id,
		key: t.key,
		label: t.label,
		description: t.description ?? "",
		parentId: t.parent_id ?? "",
		appliesToFiles: t.applies_to_files ?? true,
		appliesToNotes: t.applies_to_notes ?? true,
		createdAt: t.created_at,
		updatedAt: t.updated_at,
	}));

export const NoteTypesListResponseSchema = z
	.object({
		types: z.array(NoteTypeApiSchema),
	})
	.transform((r) => ({
		types: r.types,
	}));

export const NoteTypeResponseSchema = z
	.object({
		type: NoteTypeApiSchema,
	})
	.transform((r) => ({
		type: r.type,
	}));

const LinkPredicateApiSchema = z
	.object({
		id: z.string(),
		nook_id: z.string(),
		key: z.string(),
		forward_label: z.string(),
		reverse_label: z.string(),
		supports_start_date: z.boolean().optional(),
		supports_end_date: z.boolean().optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
	})
	.transform((p) => ({
		id: p.id,
		nookId: p.nook_id,
		key: p.key,
		forwardLabel: p.forward_label,
		reverseLabel: p.reverse_label,
		supportsStartDate: p.supports_start_date ?? false,
		supportsEndDate: p.supports_end_date ?? false,
		createdAt: p.created_at,
		updatedAt: p.updated_at,
	}));

export const LinkPredicatesListResponseSchema = z
	.object({
		predicates: z.array(LinkPredicateApiSchema),
	})
	.transform((r) => ({
		predicates: r.predicates,
	}));

export const LinkPredicateResponseSchema = z
	.object({
		predicate: LinkPredicateApiSchema,
	})
	.transform((r) => ({
		predicate: r.predicate,
	}));

const LinkPredicateRuleApiSchema = z
	.object({
		id: z.number().int(),
		predicate_id: z.string(),
		source_type_id: z.string().optional(),
		target_type_id: z.string().optional(),
		include_source_subtypes: z.boolean().optional(),
		include_target_subtypes: z.boolean().optional(),
	})
	.transform((r) => ({
		id: r.id,
		predicateId: r.predicate_id,
		sourceTypeId: r.source_type_id ?? "",
		targetTypeId: r.target_type_id ?? "",
		includeSourceSubtypes: r.include_source_subtypes ?? true,
		includeTargetSubtypes: r.include_target_subtypes ?? true,
	}));

export const LinkPredicateRulesListResponseSchema = z
	.object({
		rules: z.array(LinkPredicateRuleApiSchema),
	})
	.transform((r) => ({
		rules: r.rules,
	}));

const NoteLinkApiSchema = z
	.object({
		id: z.string(),
		nook_id: z.string(),
		predicate_id: z.string(),
		predicate_key: z.string().optional(),
		forward_label: z.string().optional(),
		reverse_label: z.string().optional(),
		supports_start_date: z.boolean().optional(),
		supports_end_date: z.boolean().optional(),
		source_note_id: z.string(),
		target_note_id: z.string(),
		start_date: z.string().optional(),
		end_date: z.string().optional(),
		former: z.record(z.string(), z.unknown()).optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
	})
	.transform((l) => ({
		id: l.id,
		nookId: l.nook_id,
		predicateId: l.predicate_id,
		predicateKey: l.predicate_key ?? "",
		forwardLabel: l.forward_label ?? "",
		reverseLabel: l.reverse_label ?? "",
		supportsStartDate: l.supports_start_date ?? false,
		supportsEndDate: l.supports_end_date ?? false,
		sourceNoteId: l.source_note_id,
		targetNoteId: l.target_note_id,
		startDate: l.start_date ?? "",
		endDate: l.end_date ?? "",
		former: l.former ?? {},
		createdAt: l.created_at,
		updatedAt: l.updated_at,
	}));

export const NoteLinksListResponseSchema = z
	.object({
		links: z.array(NoteLinkApiSchema),
	})
	.transform((r) => ({
		links: r.links,
	}));

export const NoteLinkResponseSchema = z
	.object({
		link: NoteLinkApiSchema,
	})
	.transform((r) => ({
		link: r.link,
	}));

export type NoteSummary = z.infer<typeof NoteSummaryApiSchema>;
export type Note = z.infer<typeof NoteDetailApiSchema>;
export type Mention = z.infer<typeof MentionApiSchema>;
export type NotesListResponse = z.infer<typeof NotesListResponseSchema>;
export type NoteTypeNotesResponse = z.infer<typeof NoteTypeNotesResponseSchema>;
export type NoteResponse = z.infer<typeof NoteResponseSchema>;
export type MentionsResponse = z.infer<typeof MentionsResponseSchema>;
export type NoteType = z.infer<typeof NoteTypeApiSchema>;
export type NoteTypesListResponse = z.infer<typeof NoteTypesListResponseSchema>;
export type NoteTypeResponse = z.infer<typeof NoteTypeResponseSchema>;
export type LinkPredicate = z.infer<typeof LinkPredicateApiSchema>;
export type LinkPredicateRule = z.infer<typeof LinkPredicateRuleApiSchema>;
export type NoteLink = z.infer<typeof NoteLinkApiSchema>;
