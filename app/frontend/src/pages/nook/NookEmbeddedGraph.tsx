import { useLocation } from "@solidjs/router";
import { createMemo } from "solid-js";
import { NookGraphPanel } from "./NookGraphPanel";
import type { NookStore } from "./store";
import type { GraphViewProperties } from "./types";

export type NookEmbeddedGraphProps = {
	store: NookStore;
	graphProps: GraphViewProperties;
	onConfigChange: (config: GraphViewProperties) => void;
	onSave: (config: GraphViewProperties) => Promise<void>;
};

export function NookEmbeddedGraph(props: NookEmbeddedGraphProps) {
	const store = () => props.store;
	const location = useLocation();
	const isFullscreen = createMemo(() => {
		const params = new URLSearchParams(location.search);
		return params.has("fullscreen");
	});

	return (
		<NookGraphPanel
			store={store()}
			embedded={!isFullscreen()}
			fullscreen={isFullscreen()}
			rootNoteId={props.graphProps.rootNoteId}
			initialConfig={props.graphProps}
			onSaveConfig={props.onSave}
			onDirty={props.onConfigChange}
		/>
	);
}
