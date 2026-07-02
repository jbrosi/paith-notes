import { Show } from "solid-js";
import { useUi } from "../ui/UiContext";
import styles from "./MobileChatToggle.module.css";

/**
 * Floating action button on mobile that OPENS the AI chat panel.
 *
 * The Nav has a "Chat" button too, but on mobile the nav bar is
 * cramped and users hunt for the toggle — especially when they're
 * mid-note and want a quick answer. A persistent bottom-right FAB
 * keeps the open action one tap away.
 *
 * Hidden entirely when the chat panel is already open: the panel's
 * own top-bar X button handles closing. The old design had the FAB
 * flip to an X, which sat directly above the message Send button and
 * was easy to hit by accident when tapping Send on a small screen.
 *
 * Also hidden on desktop (>1024px), where the resizable chat sidebar
 * + Nav button already make the toggle obvious.
 */
export function MobileChatToggle() {
	const ui = useUi();

	return (
		<Show when={!ui.chatPanelOpen()}>
			<button
				type="button"
				class={styles.fab}
				onClick={() => ui.setChatPanelOpen(true)}
				aria-label="Open AI chat"
				title="Open AI chat"
			>
				{/* Chat bubble with a sparkle to signal AI, not raw messaging */}
				<svg
					aria-hidden="true"
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					<path d="M12 8v4" />
					<path d="M12 16h.01" />
				</svg>
			</button>
		</Show>
	);
}
