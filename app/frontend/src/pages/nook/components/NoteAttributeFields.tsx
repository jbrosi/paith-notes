import { createMemo, For, Show } from "solid-js";
import type { NookStore } from "../store";
import { AttributeField } from "./attributes/AttributeField";
import { FileAttributeField } from "./attributes/FileAttributeField";
import { GraphAttributeField } from "./attributes/GraphAttributeField";
import { HistoryAttributeField } from "./attributes/HistoryAttributeField";
import { LinkedNotesAttributeField } from "./attributes/LinkedNotesAttributeField";
import { MetadataAttributeField } from "./attributes/MetadataAttributeField";
import { TocAttributeField } from "./attributes/TocAttributeField";
import { ViewAttributeField } from "./attributes/ViewAttributeField";

export function NoteAttributeFields(props: {
	store: NookStore;
	/** Override type ID (e.g. for snapshot view) */
	typeIdOverride?: string;
	/** Override attribute values (e.g. for snapshot view) */
	valuesOverride?: Record<string, unknown>;
	/** Force read-only mode */
	readonly?: boolean;
}) {
	const attributes = createMemo(() => {
		const typeId = props.typeIdOverride ?? props.store.typeId();
		if (!typeId) return [];
		return props.store.resolveTypeAttributes(typeId);
	});

	const noteAttributes = () =>
		(props.valuesOverride ?? props.store.noteAttributes?.() ?? {}) as Record<string, unknown>;

	const setAttr = (attrId: string, value: unknown) => {
		if (props.readonly) return;
		props.store.setNoteAttribute?.(attrId, value);
	};

	const nonInlineKinds = new Set(["file", "graph", "view", "linked_notes", "history", "toc", "metadata"]);
	const simpleAttrs = () =>
		attributes()?.filter((a) => !nonInlineKinds.has(a.kind)) ?? [];
	const fileAttrs = () => attributes()?.filter((a) => a.kind === "file") ?? [];
	const graphAttrs = () =>
		attributes()?.filter((a) => a.kind === "graph") ?? [];
	const viewAttrs = () =>
		attributes()?.filter((a) => a.kind === "view") ?? [];
	const linkedNotesAttrs = () =>
		attributes()?.filter((a) => a.kind === "linked_notes") ?? [];
	const historyAttrs = () =>
		attributes()?.filter((a) => a.kind === "history") ?? [];
	const tocAttrs = () =>
		attributes()?.filter((a) => a.kind === "toc") ?? [];
	const metadataAttrs = () =>
		attributes()?.filter((a) => a.kind === "metadata") ?? [];

	return (
		<>
			<Show when={simpleAttrs().length > 0 || fileAttrs().length > 0}>
				<div
					style={{
						display: "grid",
						gap: "8px",
						padding: "8px 0",
						"border-top": "1px solid var(--color-border-light)",
						"margin-top": "8px",
					}}
				>
					<For each={simpleAttrs()}>
						{(attr) => (
							<AttributeField
								attr={attr}
								value={noteAttributes()[attr.id]}
								onChange={(v) => setAttr(attr.id, v)}
								disabled={props.store.mode() !== "edit"}
							/>
						)}
					</For>
					<For each={fileAttrs()}>
						{(attr) => (
							<FileAttributeField
								attr={attr}
								store={props.store}
								readonly={props.readonly}
							/>
						)}
					</For>
				</div>
			</Show>
			<For each={graphAttrs()}>
				{(attr) => (
					<GraphAttributeField
						attr={attr}
						value={
							noteAttributes()[attr.id] as Record<string, unknown> | undefined
						}
						onChange={(v) => setAttr(attr.id, v)}
						store={props.store}
					/>
				)}
			</For>
			<For each={viewAttrs()}>
				{(attr) => (
					<ViewAttributeField
						attr={attr}
						value={
							noteAttributes()[attr.id] as Record<string, unknown> | undefined
						}
						onChange={(v) => setAttr(attr.id, v)}
						store={props.store}
					/>
				)}
			</For>
			<For each={linkedNotesAttrs()}>
				{(attr) => (
					<LinkedNotesAttributeField
						attr={attr}
						store={props.store}
					/>
				)}
			</For>
			<For each={metadataAttrs()}>
				{(attr) => (
					<MetadataAttributeField
						attr={attr}
						store={props.store}
					/>
				)}
			</For>
			<For each={tocAttrs()}>
				{(attr) => (
					<TocAttributeField
						attr={attr}
						store={props.store}
					/>
				)}
			</For>
			<For each={historyAttrs()}>
				{(attr) => (
					<HistoryAttributeField
						attr={attr}
						store={props.store}
					/>
				)}
			</For>
		</>
	);
}
