import { Show } from "solid-js";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";
import { formatTimeAgo } from "./HistoryAttributeField";

export function MetadataAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	fullscreen?: boolean;
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

	const hasAny = () => {
		const cfg = config();
		return (
			(cfg.showVersion && props.store.noteVersion() > 0) ||
			(cfg.showViews && props.store.viewCount() > 0) ||
			(cfg.showCreated && props.store.noteCreatedAt()) ||
			(cfg.showUpdated && props.store.noteUpdatedAt())
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
				<Show when={config().showCreated && props.store.noteCreatedAt()}>
					<span>
						Created{props.store.noteCreatedByName() ? ` by ${props.store.noteCreatedByName()}` : ""}{" "}
						{formatTimeAgo(props.store.noteCreatedAt())}
					</span>
				</Show>
				<Show when={config().showUpdated && props.store.noteUpdatedAt() && props.store.noteUpdatedAt() !== props.store.noteCreatedAt()}>
					<span>
						Edited {formatTimeAgo(props.store.noteUpdatedAt())}
					</span>
				</Show>
			</div>
		</Show>
	);
}
