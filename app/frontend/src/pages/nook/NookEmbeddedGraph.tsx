import { useLocation } from "@solidjs/router";
import { createMemo, Show } from "solid-js";
import { NookGraphPanel } from "./NookGraphPanel";
import type { NookStore } from "./store";
import type { GraphViewProperties } from "./types";

export type NookEmbeddedGraphProps = {
	store: NookStore;
};

export function NookEmbeddedGraph(props: NookEmbeddedGraphProps) {
	const store = () => props.store;
	const location = useLocation();
	const graphProps = () => store().graphProperties();
	const isFullscreen = createMemo(() => {
		const params = new URLSearchParams(location.search);
		return params.has("fullscreen");
	});

	const handleSave = async (config: GraphViewProperties) => {
		store().setGraphProperties(config);
		await store().saveNote();
	};

	return (
		<Show when={graphProps()}>
			{(gp) => (
				<NookGraphPanel
					store={store()}
					embedded={!isFullscreen()}
					fullscreen={isFullscreen()}
					rootNoteId={gp().rootNoteId}
					initialConfig={gp()}
					onSaveConfig={handleSave}
					onDirty={() => store().setIsDirty(true)}
				/>
			)}
		</Show>
	);
}
