import { useUi } from "../ui/UiContext";
import styles from "./MobileChatToggle.module.css";

/**
 * Floating action button on mobile that toggles the AI chat panel.
 *
 * The Nav has a "Chat" button too, but on mobile the nav bar is
 * cramped and users hunt for the toggle — especially when they're
 * mid-note and want a quick answer. A persistent bottom-right FAB
 * keeps the switch one tap away.
 *
 * Hidden entirely on desktop (>1024px), where the resizable chat
 * sidebar and the Nav button already make the toggle obvious.
 *
 * When chat is open the button flips to a "close" icon in a subdued
 * color, so it acts as both open and close from the same anchor.
 */
export function MobileChatToggle() {
	const ui = useUi();

	return (
		<button
			type="button"
			class={styles.fab}
			classList={{ [styles.fabActive]: ui.chatPanelOpen() }}
			onClick={() => ui.toggleChatPanel()}
			aria-label={ui.chatPanelOpen() ? "Close AI chat" : "Open AI chat"}
			aria-pressed={ui.chatPanelOpen()}
			title={ui.chatPanelOpen() ? "Close chat" : "Open AI chat"}
		>
			{ui.chatPanelOpen() ? (
				// Close (X) — indicates tapping will hide the chat
				<svg
					aria-hidden="true"
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2.4"
					stroke-linecap="round"
					stroke-linejoin="round"
				>
					<path d="M18 6 6 18" />
					<path d="m6 6 12 12" />
				</svg>
			) : (
				// Chat bubble with a sparkle to signal AI, not raw messaging
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
			)}
		</button>
	);
}
