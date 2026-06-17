import { useLocation } from "@solidjs/router";
import { createMemo } from "solid-js";
import { NookGraphPanel } from "./NookGraphPanel";
import type { NookStore } from "./store";
import { type GraphViewProperties, graphParamsToConfig } from "./types";

export type NookEmbeddedGraphProps = {
	store: NookStore;
	graphProps: GraphViewProperties;
	onConfigChange: (config: GraphViewProperties) => void;
	/** Provided only when the user can persist overrides (edit mode +
	 * allow_override_in_note enabled). Hides the Reset button otherwise. */
	onReset?: () => void;
};

export function NookEmbeddedGraph(props: NookEmbeddedGraphProps) {
	const store = () => props.store;
	const location = useLocation();
	const isFullscreen = createMemo(() => {
		const params = new URLSearchParams(location.search);
		return params.has("fullscreen");
	});

	// When entering fullscreen, the URL itself may carry config overrides
	// (a shared "graph link"). Layer them on top of props.graphProps so the
	// URL wins for any field it sets.
	const effectiveGraphProps = createMemo((): GraphViewProperties => {
		if (!isFullscreen()) return props.graphProps;
		const overrides = graphParamsToConfig(new URLSearchParams(location.search));
		return { ...props.graphProps, ...stripUndefined(overrides) };
	});

	return (
		<NookGraphPanel
			store={store()}
			fullscreen={isFullscreen()}
			rootNoteId={effectiveGraphProps().rootNoteId}
			initialConfig={effectiveGraphProps()}
			onDirty={props.onConfigChange}
			onReset={props.onReset}
		/>
	);
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
	const out: Partial<T> = {};
	for (const k in obj) {
		const v = obj[k];
		if (v !== undefined) out[k] = v;
	}
	return out;
}
