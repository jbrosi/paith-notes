import { z } from "zod";

const NoteTypeEnum = z
	.string()
	.transform((v) => {
		if (v === "file" || v === "graph") return v;
		return "anything" as const;
	})
	.pipe(z.enum(["anything", "file", "graph"]));

export const GraphLayoutEnum = z.enum(["force", "tree", "radial"]);
export type GraphLayout = z.infer<typeof GraphLayoutEnum>;

export const GraphViewPropertiesSchema = z.object({
	rootNoteId: z.string(),
	depth: z.number().int().min(1).max(5).optional(),
	includeFiles: z.boolean().optional(),
	filterTypeIds: z.array(z.string()).optional(),
	filterPredicateIds: z.array(z.string()).optional(),
	hiddenNodeIds: z.array(z.string()).optional(),
	// Display settings
	layout: GraphLayoutEnum.optional(),
	linkDistance: z.number().min(20).max(300).optional(),
	chargeStrength: z.number().min(-1000).max(0).optional(),
	nodeSize: z.number().min(3).max(20).optional(),
	linkWidth: z.number().min(0.5).max(5).optional(),
});

export type GraphViewProperties = z.infer<typeof GraphViewPropertiesSchema>;

export function parseGraphProperties(
	raw: Record<string, unknown>,
): GraphViewProperties | null {
	const result = GraphViewPropertiesSchema.safeParse(raw);
	return result.success ? result.data : null;
}

export function serializeGraphProperties(
	props: GraphViewProperties,
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		rootNoteId: props.rootNoteId,
	};
	if (props.depth !== undefined && props.depth !== 2) out.depth = props.depth;
	if (props.includeFiles) out.includeFiles = true;
	if (props.filterTypeIds?.length) out.filterTypeIds = props.filterTypeIds;
	if (props.filterPredicateIds?.length)
		out.filterPredicateIds = props.filterPredicateIds;
	if (props.hiddenNodeIds?.length) out.hiddenNodeIds = props.hiddenNodeIds;
	if (props.layout && props.layout !== "force") out.layout = props.layout;
	if (props.linkDistance !== undefined && props.linkDistance !== 90)
		out.linkDistance = props.linkDistance;
	if (props.chargeStrength !== undefined && props.chargeStrength !== -280)
		out.chargeStrength = props.chargeStrength;
	if (props.nodeSize !== undefined && props.nodeSize !== 6)
		out.nodeSize = props.nodeSize;
	if (props.linkWidth !== undefined && props.linkWidth !== 1)
		out.linkWidth = props.linkWidth;
	return out;
}

const NoteSummaryApiSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		type_id: z.string().optional(),
		outgoing_mentions_count: z.number().int().optional(),
		incoming_mentions_count: z.number().int().optional(),
		outgoing_links_count: z.number().int().optional(),
		incoming_links_count: z.number().int().optional(),
		type: NoteTypeEnum.optional(),
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
		type: NoteTypeEnum.optional(),
		properties: z.record(z.string(), z.unknown()).optional(),
		former_properties: z.record(z.string(), z.unknown()).optional(),
		version: z.number().int().optional(),
		view_count: z.number().int().optional(),
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
		version: n.version ?? 0,
		viewCount: n.view_count ?? 0,
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
		nook_id: z.string().optional(),
		note_title: z.string(),
		link_title: z.string(),
		position: z.number().int(),
	})
	.transform((m) => ({
		noteId: m.note_id,
		nookId: m.nook_id ?? "",
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
		applies_to: z.string().optional(),
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
		appliesTo: (t.applies_to ?? "notes") as "notes" | "files",
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
		source_note_title: z.string().optional(),
		source_note_type: NoteTypeEnum.optional(),
		target_note_id: z.string(),
		target_note_title: z.string().optional(),
		target_note_type: NoteTypeEnum.optional(),
		start_date: z.string().optional(),
		end_date: z.string().optional(),
		former: z.record(z.string(), z.unknown()).optional(),
		last_actor: z.string().optional(),
		last_user_name: z.string().optional(),
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
		sourceNoteTitle: l.source_note_title ?? "",
		sourceNoteType: l.source_note_type ?? "anything",
		targetNoteId: l.target_note_id,
		targetNoteTitle: l.target_note_title ?? "",
		targetNoteType: l.target_note_type ?? "anything",
		startDate: l.start_date ?? "",
		endDate: l.end_date ?? "",
		former: l.former ?? {},
		lastActor: l.last_actor ?? "user",
		lastUserName: l.last_user_name ?? "",
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

const NoteHistoryEntrySchema = z
	.object({
		id: z.number().int(),
		version: z.number().int(),
		action: z.string(),
		actor: z.string().optional(),
		type: z.string().optional(),
		linked_note_id: z.string().optional(),
		linked_note_title: z.string().optional(),
		link_label: z.string().optional(),
		user_id: z.string(),
		user_name: z.string(),
		created_at: z.string(),
	})
	.transform((h) => ({
		id: h.id,
		version: h.version,
		action: h.action,
		actor: h.actor ?? "user",
		type: h.type ?? "note",
		linkedNoteId: h.linked_note_id ?? "",
		linkedNoteTitle: h.linked_note_title ?? "",
		linkLabel: h.link_label ?? "",
		userId: h.user_id,
		userName: h.user_name,
		createdAt: h.created_at,
	}));

export const NoteHistoryResponseSchema = z
	.object({
		history: z.array(NoteHistoryEntrySchema),
	})
	.transform((r) => ({
		history: r.history,
	}));

export type NoteHistoryEntry = z.infer<typeof NoteHistoryEntrySchema>;
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
