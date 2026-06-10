import { useNavigate } from "@solidjs/router";
import { Button } from "../../../../components/Button";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";

export function SourceAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	/** When true, renders the full source view instead of just a button */
	fullscreen?: boolean;
}) {
	const navigate = useNavigate();

	const openFullscreen = () => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		const key = props.attr.key || "source";
		if (nookId && noteId) {
			navigate(
				`/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/attr/${encodeURIComponent(key)}`,
			);
		}
	};

	// In a panel: show a compact button to open fullscreen
	if (!props.fullscreen) {
		return (
			<div style={{ padding: "8px 0" }}>
				<Button variant="secondary" size="small" onClick={openFullscreen}>
					Show source
				</Button>
			</div>
		);
	}

	// Fullscreen: show the raw markdown textarea
	return (
		<textarea
			readOnly
			value={props.store.content()}
			style={{
				width: "100%",
				height: "100%",
				"min-height": "400px",
				"box-sizing": "border-box",
				padding: "12px",
				"font-family": "monospace",
				"font-size": "13px",
				"line-height": "1.5",
				border: "1px solid var(--color-border-light)",
				"border-radius": "6px",
				background: "var(--color-bg-secondary)",
				color: "var(--color-text)",
				resize: "vertical",
			}}
		/>
	);
}
