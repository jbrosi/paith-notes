import { Show } from "solid-js";
import { NookMainPanel } from "./NookMainPanel";
import { NookStatusPanel } from "./NookStatusPanel";
import { NookGraphPanel } from "./NookGraphPanel";
import type { NookStore } from "./store";

export type NookDefaultLayoutProps = {
	nookId: string;
	store: NookStore;
	showGraph: boolean;
};

export function NookDefaultLayout(props: NookDefaultLayoutProps) {
	return (
		<div
			style={{
				display: "flex",
				gap: "16px",
				"align-items": "stretch",
			}}
		>
			<div style={{ flex: "1", "min-width": "0" }}>
				<NookMainPanel
					store={props.store}
				/>
				<NookStatusPanel store={props.store} />
			</div>

			<Show when={props.showGraph}>
				<NookGraphPanel store={props.store} />
			</Show>
		</div>
	);
}
