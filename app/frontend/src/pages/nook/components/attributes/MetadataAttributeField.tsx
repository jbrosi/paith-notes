import { Show } from "solid-js";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";
import { formatTimeAgo } from "./HistoryAttributeField";

export function MetadataAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
}) {
	const config = () => {
		const c = props.attr.config;
		return {
			showVersion: c.show_version !== false,
			showCreated: c.show_created !== false,
			showUpdated: c.show_updated !== false,
			showViews: c.show_views !== false,
		};
	};

	const history = () => props.store.noteHistory();
	const createdEntry = () => history()[history().length - 1];
	const lastEditEntry = () => history().length > 1 ? history()[0] : undefined;

	const hasAny = () => {
		const cfg = config();
		return (
			(cfg.showVersion && props.store.noteVersion() > 0) ||
			(cfg.showViews && props.store.viewCount() > 0) ||
			(cfg.showCreated && createdEntry()) ||
			(cfg.showUpdated && lastEditEntry())
		);
	};

	return (
		<Show when={hasAny()}>
			<div
				style={{
					display: "flex",
					"flex-wrap": "wrap",
					gap: "8px 16px",
					padding: "6px 0",
					"font-size": "0.7rem",
					color: "var(--color-text-muted)",
					"border-top": "1px solid var(--color-border-light)",
					"margin-top": "8px",
				}}
			>
				<Show when={config().showVersion && props.store.noteVersion() > 0}>
					<span>v{props.store.noteVersion()}</span>
				</Show>
				<Show when={config().showViews && props.store.viewCount() > 0}>
					<span>{props.store.viewCount()} views</span>
				</Show>
				<Show when={config().showCreated && createdEntry()}>
					{(entry) => (
						<span>
							Created by {entry().userName || "Unknown"} {formatTimeAgo(entry().createdAt)}
						</span>
					)}
				</Show>
				<Show when={config().showUpdated && lastEditEntry()}>
					{(entry) => (
						<span>
							Edited by {entry().userName || "Unknown"} {formatTimeAgo(entry().createdAt)}
						</span>
					)}
				</Show>
			</div>
		</Show>
	);
}
