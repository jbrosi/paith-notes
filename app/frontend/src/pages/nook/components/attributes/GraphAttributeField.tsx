import { Show } from "solid-js";
import { NookEmbeddedGraph } from "../../NookEmbeddedGraph";
import type { NookStore } from "../../store";
import {
	type GraphViewProperties,
	parseGraphProperties,
	serializeGraphProperties,
	type TypeAttribute,
} from "../../types";

export function GraphAttributeField(props: {
	attr: TypeAttribute;
	value: Record<string, unknown> | undefined;
	onChange: (v: unknown) => void;
	store: NookStore;
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
				<NookEmbeddedGraph
					store={props.store}
					graphProps={gp()}
					onConfigChange={handleConfigChange}
					onSave={handleSave}
				/>
			)}
		</Show>
	);
}
