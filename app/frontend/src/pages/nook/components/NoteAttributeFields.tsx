import { createMemo, For } from "solid-js";
import type { NookStore } from "../store";
import type { TypeAttribute } from "../types";
import { AttributeField } from "./attributes/AttributeField";
import { ContentAttributeField } from "./attributes/ContentAttributeField";
import { FileAttributeField } from "./attributes/FileAttributeField";
import { GraphAttributeField } from "./attributes/GraphAttributeField";
import { HistoryAttributeField } from "./attributes/HistoryAttributeField";
import { LinkedNotesAttributeField } from "./attributes/LinkedNotesAttributeField";
import { MentionsAttributeField } from "./attributes/MentionsAttributeField";
import { MetadataAttributeField } from "./attributes/MetadataAttributeField";
import { SourceAttributeField } from "./attributes/SourceAttributeField";
import { TocAttributeField } from "./attributes/TocAttributeField";
import { ViewAttributeField } from "./attributes/ViewAttributeField";

/** Kinds rendered inline as simple form fields — grouped together with a border */
const SIMPLE_KINDS = new Set([
	"text",
	"number",
	"boolean",
	"date",
	"date_range",
	"select",
	"multi_select",
	"url",
	"file",
	"dimension",
]);

export function NoteAttributeFields(props: {
	store: NookStore;
	typeIdOverride?: string;
	valuesOverride?: Record<string, unknown>;
	readonly?: boolean;
	/** When set, only render attributes assigned to this panel key */
	panelFilter?: string;
}) {
	const attributes = createMemo(() => {
		const typeId = props.typeIdOverride ?? props.store.typeId();
		if (!typeId) return [];
		const allAttrs = props.store.resolveTypeAttributes(typeId);

		// If no panel filter, show all attributes (backwards compat)
		if (!props.panelFilter) return allAttrs;

		// Filter to only attributes in the specified panel
		const panels = props.store.resolveTypeLayout(typeId);
		const panel = panels.find((p) => p.key === props.panelFilter);
		if (!panel) return [];

		// Preserve panel attribute ordering
		const attrMap = new Map(allAttrs.map((a) => [a.id, a]));
		const ordered: TypeAttribute[] = [];
		for (const id of panel.attributes) {
			const attr = attrMap.get(id);
			if (attr) ordered.push(attr);
		}

		// If this is the main panel, also include unassigned attributes
		if (panel.position === "main") {
			const allAssigned = new Set(panels.flatMap((p) => p.attributes));
			for (const attr of allAttrs) {
				if (!allAssigned.has(attr.id)) ordered.push(attr);
			}
		}

		return ordered;
	});

	const noteAttributes = () =>
		(props.valuesOverride ?? props.store.noteAttributes?.() ?? {}) as Record<
			string,
			unknown
		>;

	const setAttr = (attrId: string, value: unknown) => {
		if (props.readonly) return;
		props.store.setNoteAttribute?.(attrId, value);
	};

	// Group consecutive simple attributes together for visual grouping
	const renderGroups = createMemo(() => {
		const attrs = attributes();
		const groups: Array<
			| { type: "simple"; attrs: TypeAttribute[] }
			| { type: "single"; attr: TypeAttribute }
		> = [];
		let currentSimple: TypeAttribute[] = [];

		const flushSimple = () => {
			if (currentSimple.length > 0) {
				groups.push({ type: "simple", attrs: [...currentSimple] });
				currentSimple = [];
			}
		};

		for (const attr of attrs) {
			if (SIMPLE_KINDS.has(attr.kind)) {
				currentSimple.push(attr);
			} else {
				flushSimple();
				groups.push({ type: "single", attr });
			}
		}
		flushSimple();
		return groups;
	});

	return (
		<For each={renderGroups()}>
			{(group) => {
				if (group.type === "simple") {
					return (
						<div
							style={{
								display: "grid",
								gap: "8px",
								padding: "8px 0",
								"border-top": "1px solid var(--color-border-light)",
								"margin-top": "8px",
							}}
						>
							<For each={group.attrs}>
								{(attr) =>
									attr.kind === "file" ? (
										<FileAttributeField
											attr={attr}
											store={props.store}
											readonly={props.readonly}
										/>
									) : (
										<AttributeField
											attr={attr}
											value={noteAttributes()[attr.id]}
											onChange={(v) => setAttr(attr.id, v)}
											disabled={props.store.mode() !== "edit"}
										/>
									)
								}
							</For>
						</div>
					);
				}
				const attr = group.attr;
				switch (attr.kind) {
					case "content":
						return <ContentAttributeField attr={attr} store={props.store} />;
					case "graph":
						return (
							<GraphAttributeField
								attr={attr}
								value={
									noteAttributes()[attr.id] as
										| Record<string, unknown>
										| undefined
								}
								onChange={(v) => setAttr(attr.id, v)}
								store={props.store}
							/>
						);
					case "view":
						return (
							<ViewAttributeField
								attr={attr}
								value={
									noteAttributes()[attr.id] as
										| Record<string, unknown>
										| undefined
								}
								onChange={(v) => setAttr(attr.id, v)}
								store={props.store}
							/>
						);
					case "linked_notes":
						return (
							<LinkedNotesAttributeField attr={attr} store={props.store} />
						);
					case "mentions":
						return <MentionsAttributeField attr={attr} store={props.store} />;
					case "metadata":
						return <MetadataAttributeField attr={attr} store={props.store} />;
					case "toc":
						return <TocAttributeField attr={attr} store={props.store} />;
					case "history":
						return <HistoryAttributeField attr={attr} store={props.store} />;
					case "source":
						return <SourceAttributeField attr={attr} store={props.store} />;
					default:
						return null;
				}
			}}
		</For>
	);
}
