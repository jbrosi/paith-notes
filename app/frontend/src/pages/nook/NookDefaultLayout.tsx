import { Show } from "solid-js";
import { ChatPanel } from "../../components/chat/ChatPanel";
import { useUi } from "../../ui/UiContext";
import { NookGraphPanel } from "./NookGraphPanel";
import { NookMainPanel } from "./NookMainPanel";
import { NookStatusPanel } from "./NookStatusPanel";
import type { NookStore } from "./store";

export type NookDefaultLayoutProps = {
	nookId: string;
	store: NookStore;
	showGraph: boolean;
};

export function NookDefaultLayout(props: NookDefaultLayoutProps) {
	const ui = useUi();

	return (
		<div
			style={{
				display: "flex",
				gap: "16px",
				"align-items": "stretch",
				height: "100%",
			}}
		>
			<div style={{ flex: "1", "min-width": "0", "overflow-y": "auto" }}>
				<NookMainPanel store={props.store} />
				<NookStatusPanel store={props.store} />
			</div>

			<Show when={props.showGraph}>
				<NookGraphPanel store={props.store} />
			</Show>

			<Show when={ui.chatPanelOpen()}>
				<ChatPanel
					nookId={props.nookId}
					currentNoteId={props.store.selectedId() || undefined}
					currentNoteTitle={props.store.title() || undefined}
					currentNoteType={props.store.type() || undefined}
					onClose={ui.toggleChatPanel}
					onNavigateToNote={(id) => void props.store.onNoteLinkClick(id)}
				/>
			</Show>
		</div>
	);
}
