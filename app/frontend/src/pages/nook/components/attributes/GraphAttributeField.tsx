import { Show } from "solid-js";
import { NookEmbeddedGraph } from "../../NookEmbeddedGraph";
import type { NookStore } from "../../store";
import {
	type GraphViewProperties,
	parseGraphProperties,
	serializeGraphProperties,
	type TypeAttribute,
} from "../../types";
import { FullscreenButton } from "./FullscreenButton";

export function GraphAttributeField(props: {
	attr: TypeAttribute;
	value: Record<string, unknown> | undefined;
	onChange: (v: unknown) => void;
	store: NookStore;
	fullscreen?: boolean;
}) {
	// Default the graph to the current note as root when the
	// attribute has no value yet — without this the schema rejects
	// the empty config and the whole field renders nothing (not
	// even the label), so the user couldn't tell the attribute
	// was there.
	const graphProps = (): GraphViewProperties | null => {
		const raw = (props.value as Record<string, unknown> | undefined) ?? {};
		if (typeof raw.rootNoteId !== "string" || raw.rootNoteId === "") {
			raw.rootNoteId = props.store.selectedId();
		}
		return parseGraphProperties(raw);
	};

	const handleConfigChange = (config: GraphViewProperties) => {
		props.onChange(serializeGraphProperties(config));
		props.store.setIsDirty(true);
	};

	const handleSave = async (config: GraphViewProperties) => {
		props.onChange(serializeGraphProperties(config));
		await props.store.saveNote();
	};

	return (
		<div>
			<div
				style={{
					display: "flex",
					"align-items": "center",
					"justify-content": "space-between",
					padding: "4px 0",
				}}
			>
				<div
					style={{
						"font-size": "12px",
						color: "var(--color-text-secondary)",
					}}
				>
					{props.attr.name}
				</div>
				<Show when={!props.fullscreen}>
					<FullscreenButton attr={props.attr} store={props.store} />
				</Show>
			</div>
			<Show
				when={graphProps()}
				fallback={
					<div
						style={{
							padding: "12px",
							"font-size": "13px",
							color: "var(--color-text-muted)",
							"font-style": "italic",
						}}
					>
						Open a note to see its graph here.
					</div>
				}
			>
				{(gp) => (
					<NookEmbeddedGraph
						store={props.store}
						graphProps={gp()}
						onConfigChange={handleConfigChange}
						onSave={handleSave}
					/>
				)}
			</Show>
		</div>
	);
}
