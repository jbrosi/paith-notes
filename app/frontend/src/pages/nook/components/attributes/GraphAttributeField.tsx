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
	const graphProps = (): GraphViewProperties | null => {
		if (!props.value) return null;
		return parseGraphProperties(props.value as Record<string, unknown>);
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
		<Show when={graphProps()}>
			{(gp) => (
				<div>
					<Show when={!props.fullscreen}>
						<div style={{ display: "flex", "justify-content": "flex-end", padding: "4px 0" }}>
							<FullscreenButton attr={props.attr} store={props.store} />
						</div>
					</Show>
					<NookEmbeddedGraph
						store={props.store}
						graphProps={gp()}
						onConfigChange={handleConfigChange}
						onSave={handleSave}
					/>
				</div>
			)}
		</Show>
	);
}
