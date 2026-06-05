import { useNavigate } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { Button } from "../../components/Button";
import { ContentAttributeField } from "./components/attributes/ContentAttributeField";
import { GraphAttributeField } from "./components/attributes/GraphAttributeField";
import { HistoryAttributeField } from "./components/attributes/HistoryAttributeField";
import { LinkedNotesAttributeField } from "./components/attributes/LinkedNotesAttributeField";
import { MentionsAttributeField } from "./components/attributes/MentionsAttributeField";
import { MetadataAttributeField } from "./components/attributes/MetadataAttributeField";
import { SourceAttributeField } from "./components/attributes/SourceAttributeField";
import { TocAttributeField } from "./components/attributes/TocAttributeField";
import { ViewAttributeField } from "./components/attributes/ViewAttributeField";
import type { NookStore } from "./store";
import type { TypeAttribute } from "./types";

export type NookFullscreenAttrProps = {
	store: NookStore;
	attrKey: string;
};

export function NookFullscreenAttr(props: NookFullscreenAttrProps) {
	const navigate = useNavigate();

	const attr = createMemo(() => {
		const typeId = props.store.typeId();
		if (!typeId) return null;
		const attrs = props.store.resolveTypeAttributes(typeId);
		return attrs.find((a) => a.key === props.attrKey) ?? null;
	});

	const goBack = () => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		if (nookId && noteId) {
			navigate(
				`/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}`,
			);
		}
	};

	return (
		<div style={{ width: "100%", height: "100%", display: "flex", "flex-direction": "column" }}>
			<div style={{
				display: "flex",
				"align-items": "center",
				gap: "12px",
				padding: "12px 16px",
				"border-bottom": "1px solid var(--color-border-light)",
				"flex-shrink": "0",
			}}>
				<Button variant="secondary" size="small" onClick={goBack}>
					Back
				</Button>
				<Show when={attr()}>
					<span style={{ "font-size": "0.9rem", color: "var(--color-text-secondary)" }}>
						{props.store.title()} — <strong>{attr()!.name}</strong>
					</span>
				</Show>
			</div>

			<div style={{ flex: "1", overflow: "auto", padding: "16px" }}>
				<Show
					when={attr()}
					fallback={
						<div style={{ color: "var(--color-text-muted)" }}>
							Attribute "{props.attrKey}" not found on this note's type.
						</div>
					}
				>
					{(a) => <FullscreenField attr={a()} store={props.store} />}
				</Show>
			</div>
		</div>
	);
}

function FullscreenField(props: { attr: TypeAttribute; store: NookStore }) {
	const noteAttributes = () => props.store.noteAttributes?.() ?? {};
	const setAttr = (value: unknown) => {
		props.store.setNoteAttribute?.(props.attr.id, value);
	};

	switch (props.attr.kind) {
		case "content":
			return <ContentAttributeField attr={props.attr} store={props.store} fullscreen />;
		case "graph":
			return (
				<GraphAttributeField
					attr={props.attr}
					value={noteAttributes()[props.attr.id] as Record<string, unknown> | undefined}
					onChange={setAttr}
					store={props.store}
					fullscreen
				/>
			);
		case "view":
			return (
				<ViewAttributeField
					attr={props.attr}
					value={noteAttributes()[props.attr.id] as Record<string, unknown> | undefined}
					onChange={setAttr}
					store={props.store}
					fullscreen
				/>
			);
		case "linked_notes":
			return <LinkedNotesAttributeField attr={props.attr} store={props.store} fullscreen />;
		case "mentions":
			return <MentionsAttributeField attr={props.attr} store={props.store} fullscreen />;
		case "metadata":
			return <MetadataAttributeField attr={props.attr} store={props.store} fullscreen />;
		case "toc":
			return <TocAttributeField attr={props.attr} store={props.store} fullscreen />;
		case "history":
			return <HistoryAttributeField attr={props.attr} store={props.store} fullscreen />;
		case "source":
			return <SourceAttributeField attr={props.attr} store={props.store} fullscreen />;
		default:
			return <div style={{ color: "var(--color-text-muted)" }}>This attribute kind cannot be displayed fullscreen.</div>;
	}
}
