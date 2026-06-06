import { createEffect, createMemo, For, Show } from "solid-js";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";
import { FullscreenButton } from "./FullscreenButton";

export function formatTimeAgo(iso: string): string {
	try {
		const d = new Date(iso);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffMin = Math.floor(diffMs / 60000);
		if (diffMin < 1) return "just now";
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffH = Math.floor(diffMin / 60);
		if (diffH < 24) return `${diffH}h ago`;
		const diffD = Math.floor(diffH / 24);
		if (diffD < 7) return `${diffD}d ago`;
		return d.toLocaleDateString();
	} catch {
		return iso;
	}
}

export function HistoryAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	fullscreen?: boolean;
}) {
	// Load history when this component mounts / note changes
	createEffect(() => {
		if (props.store.selectedId()) {
			void props.store.loadHistory();
		}
	});

	const limit = () => {
		const v = Number(props.attr.config.limit ?? 5);
		return Math.max(0, v);
	};

	const entries = createMemo(() => {
		const l = limit();
		if (l === 0) return [];
		return props.store.noteHistory().slice(0, l);
	});

	const nookId = () => props.store.nookId();
	const noteId = () => props.store.selectedId();
	const historyHref = () => {
		const nook = nookId();
		const note = noteId();
		if (!nook || !note) return "";
		return `/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(note)}/history`;
	};

	const currentVersionLabel = createMemo(() => {
		const v = props.store.noteVersion();
		if (!v) return "";
		// Find the latest history entry to get the author
		const latest = props.store.noteHistory()[0];
		if (latest) {
			return `v${v} — ${latest.userName || "Unknown"}, ${formatTimeAgo(latest.createdAt)}`;
		}
		return `v${v}`;
	});

	return (
		<Show
			when={entries().length > 0 || (limit() === 0 && currentVersionLabel())}
		>
			<div style={{ "margin-top": "8px" }}>
				<div
					style={{
						"font-size": "0.7rem",
						"font-weight": "600",
						color: "var(--color-text-secondary)",
						"margin-bottom": "4px",
						"text-transform": "uppercase",
						"letter-spacing": "0.03em",
						display: "flex",
						"align-items": "center",
						gap: "6px",
					}}
				>
					{props.attr.name}
					<Show when={!props.fullscreen}>
						<FullscreenButton attr={props.attr} store={props.store} />
					</Show>
					<Show when={limit() === 0 && currentVersionLabel()}>
						<span
							style={{
								"font-weight": "400",
								"text-transform": "none",
								"letter-spacing": "normal",
								color: "var(--color-text-muted)",
							}}
						>
							{currentVersionLabel()}
						</span>
					</Show>
				</div>
				<For each={entries()}>
					{(entry) => {
						const isLink = entry.type === "link";
						const isFile = entry.type === "file";
						const actionLabel = isLink
							? entry.action === "INSERT"
								? "linked"
								: entry.action === "DELETE"
									? "unlinked"
									: "updated link"
							: isFile
								? entry.action === "INSERT"
									? "uploaded"
									: entry.action === "UPDATE"
										? "re-uploaded"
										: "removed file"
								: entry.action === "INSERT"
									? "created"
									: entry.action === "UPDATE"
										? "edited"
										: entry.action === "DELETE"
											? "deleted"
											: entry.action;
						const versionHref = () => {
							if (entry.type !== "note" || !entry.version) return "";
							const nook = nookId();
							const note = noteId();
							if (!nook || !note) return "";
							return `/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(note)}/v/${entry.version}`;
						};
						return (
							<div
								style={{
									display: "flex",
									"align-items": "baseline",
									gap: "4px",
									"font-size": "0.75rem",
									"margin-bottom": "3px",
									"flex-wrap": "wrap",
								}}
							>
								<span
									style={{
										"font-weight": "500",
										color: "var(--color-text-secondary)",
									}}
								>
									{entry.userName || "Unknown"}
								</span>
								<span>{actionLabel}</span>
								<Show
									when={entry.type === "note" && entry.version && versionHref()}
								>
									<a
										href={versionHref()}
										style={{
											padding: "1px 6px",
											"border-radius": "999px",
											background: "var(--color-bg-tertiary, #f3f4f6)",
											"font-size": "0.65rem",
											"font-weight": "500",
											color: "var(--color-text-muted)",
											"text-decoration": "none",
										}}
									>
										v{entry.version}
									</a>
								</Show>
								<Show when={isFile && entry.filename}>
									<span
										style={{
											"font-size": "0.65rem",
											color: "var(--color-text-muted)",
										}}
									>
										{entry.filename}
									</span>
								</Show>
								<span
									style={{
										"font-size": "0.65rem",
										color: "var(--color-text-muted)",
										"margin-left": "auto",
									}}
								>
									{formatTimeAgo(entry.createdAt)}
								</span>
							</div>
						);
					}}
				</For>
				<Show
					when={props.store.noteHistory().length > limit() && historyHref()}
				>
					<a
						href={historyHref()}
						style={{
							"font-size": "0.7rem",
							color: "var(--link-color, #0066cc)",
							"text-decoration": "none",
							"margin-top": "4px",
							display: "inline-block",
						}}
					>
						Show full history
					</a>
				</Show>
			</div>
		</Show>
	);
}
