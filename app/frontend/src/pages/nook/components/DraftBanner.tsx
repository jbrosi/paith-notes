import { Show } from "solid-js";
import { Button } from "../../../components/Button";
import type { NookStore } from "../store";
import styles from "./DraftBanner.module.css";

/**
 * "You have a draft pending" recovery banner. Rendered inside the note
 * view whenever the store surfaces a draft newer than the note's own
 * saved state. Two actions:
 *
 *   Restore — apply the draft's title + content over the current
 *             editor buffer and mark the note dirty (so a subsequent
 *             save persists it).
 *   Discard — drop the draft (server + local) and keep the note's
 *             saved state as-is.
 *
 * Kept small and inline so the store owns the actual apply/discard
 * logic — the banner is only presentation + user intent capture.
 */
export function DraftBanner(props: { store: NookStore }) {
	return (
		<Show when={props.store.draftAvailable()}>
			{(draft) => (
				<div class={styles.banner} role="status">
					<div class={styles.text}>
						<span class={styles.title}>Unsaved draft found</span>
						<span class={styles.sub}>
							Last edited {formatTime(draft().updatedAt)}
						</span>
					</div>
					<div class={styles.actions}>
						<Button
							variant="primary"
							size="small"
							onClick={() => props.store.applyDraft()}
						>
							Restore draft
						</Button>
						<Button
							variant="secondary"
							size="small"
							onClick={() => props.store.discardDraft()}
						>
							Discard
						</Button>
					</div>
				</div>
			)}
		</Show>
	);
}

/**
 * Format the draft timestamp for the banner. Full absolute time is
 * fine — drafts are usually recent (seconds to minutes old), and the
 * relative "5s ago" wording gets stale the moment the user sits with
 * the banner open. Absolute avoids that whole class of confusion.
 */
function formatTime(iso: string): string {
	if (!iso) return "";
	try {
		const d = new Date(iso);
		return d.toLocaleString(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			month: "short",
			day: "numeric",
		});
	} catch {
		return iso;
	}
}
