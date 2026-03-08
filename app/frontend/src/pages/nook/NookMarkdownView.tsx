import type { NookStore } from "./store";

export type NookMarkdownViewProps = {
	store: NookStore;
};

export function NookMarkdownView(props: NookMarkdownViewProps) {
	return (
		<div style={{ width: "100%" }}>
			<textarea
				readOnly
				value={props.store.content()}
				style={{
					width: "100%",
					height: "calc(100vh - 220px)",
					"font-family": "monospace",
					"box-sizing": "border-box",
					padding: "12px",
				}}
			/>
		</div>
	);
}
