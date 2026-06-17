import { Show } from "solid-js";
import { NookEmbeddedGraph } from "../../NookEmbeddedGraph";
import type { NookStore } from "../../store";
import {
	type GraphViewProperties,
	parseGraphProperties,
	parseGraphTypeDefaults,
	readAllowOverride,
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
	const typeDefaults = () => parseGraphTypeDefaults(props.attr.config);
	const allowOverride = () =>
		readAllowOverride(props.attr.kind, props.attr.config);

	// Default the graph to the current note as root when the
	// attribute has no value yet — without this the schema rejects
	// the empty config and the whole field renders nothing (not
	// even the label), so the user couldn't tell the attribute
	// was there.
	//
	// When allow_override_in_note is false, the per-note value is
	// ignored entirely — the type-level defaults drive the display.
	// The saved per-note blob stays in the DB; flipping the flag
	// back on restores it.
	const graphProps = (): GraphViewProperties | null => {
		const raw = allowOverride()
			? ((props.value as Record<string, unknown> | undefined) ?? {})
			: {};
		if (typeof raw.rootNoteId !== "string" || raw.rootNoteId === "") {
			raw.rootNoteId = props.store.selectedId();
		}
		return parseGraphProperties(raw, typeDefaults());
	};

	const canPersist = () => props.store.isEditing() && allowOverride();

	const handleConfigChange = (config: GraphViewProperties) => {
		// View mode → tweaks stay local (would otherwise trigger discard
		// prompt). Overrides disabled → tweaks also stay local (no per-note
		// storage allowed). Both cases: don't propagate.
		if (!canPersist()) return;
		props.onChange(serializeGraphProperties(config));
		props.store.setIsDirty(true);
	};

	// Clearing the per-note value lets parseGraphProperties fall straight
	// through to typeDefaults — the panel re-seeds from the new
	// initialConfig automatically via its existing createEffect.
	const handleReset = () => {
		if (!canPersist()) return;
		props.onChange({});
		props.store.setIsDirty(true);
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
						onReset={canPersist() ? handleReset : undefined}
					/>
				)}
			</Show>
		</div>
	);
}
