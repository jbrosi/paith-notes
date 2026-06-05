import { z } from "zod";
import type { TypeAttribute } from "./types";

// ─── Value Schemas per kind ─────────────────────────────────────────

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const optionalDateStr = z.union([z.literal(""), dateStr]);

const valueSchemas: Record<string, (attr: TypeAttribute) => z.ZodType> = {
	text: () => z.string(),

	number: (attr) => {
		let s = z.coerce.number();
		if ((attr.config.display as string) === "rating") {
			const max = Number(attr.config.max ?? 5) || 5;
			s = s.min(0).max(max);
		}
		return s;
	},

	boolean: () => z.boolean(),

	date: () => z.union([z.literal(""), dateStr]),

	date_range: () =>
		z.object({
			from: optionalDateStr.optional().default(""),
			to: optionalDateStr.optional().default(""),
		}),

	select: (attr) => {
		const options = Array.isArray(attr.config.options)
			? (attr.config.options as string[])
			: [];
		return options.length > 0
			? z.union([z.literal(""), z.enum(options as [string, ...string[]])])
			: z.string();
	},

	multi_select: (attr) => {
		const options = Array.isArray(attr.config.options)
			? (attr.config.options as string[])
			: [];
		const item =
			options.length > 0
				? z.enum(options as [string, ...string[]])
				: z.string();
		return z.array(item);
	},

	url: () => z.union([z.literal(""), z.string().url()]),

	graph: () =>
		z.object({
			rootNoteId: z.string().optional(),
			depth: z.number().int().min(1).max(5).optional(),
			layout: z.enum(["force", "tree", "radial"]).optional(),
		}).passthrough(),

	view: () => z.record(z.string(), z.unknown()),
};

// ─── Config Schemas per kind ────────────────────────────────────────

const nonEmptyStringArray = z
	.array(z.string().min(1, "options must be non-empty strings"))
	.min(1, "requires at least one option")
	.refine((a) => new Set(a).size === a.length, "options must be unique");

const configSchemas: Record<string, z.ZodType> = {
	text: z.object({
		display: z.enum(["", "paragraph"]).optional(),
	}).passthrough(),

	number: z.object({
		display: z.enum(["", "rating"]).optional(),
		max: z.number().int().min(1).max(100).optional(),
	}).passthrough(),

	boolean: z.object({}).passthrough(),

	date: z.object({}).passthrough(),

	date_range: z.object({}).passthrough(),

	select: z.object({
		options: nonEmptyStringArray,
	}).passthrough(),

	multi_select: z.object({
		options: nonEmptyStringArray,
	}).passthrough(),

	url: z.object({}).passthrough(),

	file: z.object({
		display: z.enum(["", "download", "preview", "player"]).optional(),
	}).passthrough(),

	graph: z.object({}).passthrough(),

	view: z.object({}).passthrough(),

	content: z.object({
		mode: z.enum(["markdown", "plain", "code", "hidden"]).optional(),
	}).passthrough(),

	linked_notes: z.object({
		direction: z.enum(["outgoing", "incoming", "both"]).optional(),
	}).passthrough(),

	mentions: z.object({
		direction: z.enum(["outgoing", "incoming", "both"]).optional(),
	}).passthrough(),

	history: z.object({
		limit: z.number().int().min(0).max(100).optional(),
	}).passthrough(),

	toc: z.object({
		max_depth: z.number().int().min(1).max(6).optional(),
	}).passthrough(),

	metadata: z.object({
		show_version: z.boolean().optional(),
		show_created: z.boolean().optional(),
		show_updated: z.boolean().optional(),
		show_views: z.boolean().optional(),
	}).passthrough(),

	source: z.object({}).passthrough(),
};

// ─── Public API ─────────────────────────────────────────────────────

function formatZodError(error: z.ZodError, prefix: string): string {
	return error.issues
		.map((i) => {
			const path = i.path.length > 0 ? ` (${i.path.join(".")})` : "";
			return `${prefix}${path}: ${i.message}`;
		})
		.join("; ");
}

/**
 * Validate a single attribute value against its kind and config.
 * Returns an error message or null if valid.
 */
export function validateAttributeValue(
	attr: TypeAttribute,
	value: unknown,
): string | null {
	if (value === undefined || value === null || value === "") return null;

	const schemaFn = valueSchemas[attr.kind];
	if (!schemaFn) return null;

	const result = schemaFn(attr).safeParse(value);
	if (!result.success) {
		return formatZodError(result.error, attr.name);
	}
	return null;
}

/**
 * Validate all attribute values for a note.
 * Returns an array of error messages (empty if all valid).
 */
export function validateNoteAttributes(
	attrs: TypeAttribute[],
	values: Record<string, unknown>,
): string[] {
	const errors: string[] = [];
	const attrMap = new Map(attrs.map((a) => [a.id, a]));

	for (const [attrId, value] of Object.entries(values)) {
		if (value === null) continue;
		const attr = attrMap.get(attrId);
		if (!attr) continue;
		const err = validateAttributeValue(attr, value);
		if (err) errors.push(err);
	}

	return errors;
}

/**
 * Validate attribute config for a given kind.
 * Returns an error message or null if valid.
 */
export function validateAttributeConfig(
	kind: string,
	config: Record<string, unknown>,
): string | null {
	const schema = configSchemas[kind];
	if (!schema) return null;

	const result = schema.safeParse(config);
	if (!result.success) {
		return formatZodError(result.error, kind);
	}
	return null;
}
