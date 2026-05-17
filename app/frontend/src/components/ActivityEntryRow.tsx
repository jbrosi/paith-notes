import { A } from "@solidjs/router";
import { Show } from "solid-js";
import { ActorLabel } from "./ActorLabel";
import { TimeAgo } from "./TimeAgo";

export type ActivityEntryData = {
	actor: string;
	userName: string;
	action: string;
	/** 'note' | 'link' | other */
	type: string;
	/** For link entries (note-specific feed): the other note's title */
	linkedNoteTitle?: string;
	/** For link entries (note-specific feed): the other note's ID */
	linkedNoteId?: string;
	/** For link entries: the predicate label in the correct direction */
	linkLabel?: string;
	/** For link entries (nook-wide feed): source note title */
	linkSourceTitle?: string;
	/** For link entries (nook-wide feed): source note ID */
	linkSourceId?: string;
	/** For link entries (nook-wide feed): target note title */
	linkTargetTitle?: string;
	/** For link entries (nook-wide feed): target note ID */
	linkTargetId?: string;
	/** For note entries: version number */
	version?: number;
	createdAt: string;
};

type Props = {
	entry: ActivityEntryData;
	/** Called when version badge is clicked (note entries only) */
	onViewVersion?: (version: number) => void;
	/** Build href for a note ID (for real <A> links) */
	buildNoteHref?: (noteId: string) => string;
	/** Called on mouse enter on linked note (for preview) */
	onNoteHover?: (noteId: string, x: number, y: number) => void;
	/** Called on mouse leave on linked note */
	onNoteLeave?: () => void;
};

function actionLabel(action: string, type: string): string {
	if (type === "link") {
		if (action === "INSERT") return "linked";
		if (action === "DELETE") return "unlinked";
		return "updated link";
	}
	if (action === "INSERT") return "created";
	if (action === "UPDATE") return "edited";
	if (action === "DELETE") return "deleted";
	return action.toLowerCase();
}

function NoteLinkEl(props: {
	title: string;
	href?: string;
	noteId?: string;
	onNoteHover?: (id: string, x: number, y: number) => void;
	onNoteLeave?: () => void;
}) {
	if (props.href && props.noteId) {
		return (
			<A
				href={props.href}
				style={{
					"font-weight": "500",
					color: "var(--link-color, #0066cc)",
					"text-decoration": "none",
				}}
				onMouseEnter={(ev) => {
					if (props.noteId && props.onNoteHover) {
						const rect = ev.currentTarget.getBoundingClientRect();
						props.onNoteHover(props.noteId, rect.left, rect.bottom);
					}
				}}
				onMouseLeave={() => props.onNoteLeave?.()}
			>
				{props.title}
			</A>
		);
	}
	return <span style={{ "font-weight": "500" }}>{props.title}</span>;
}

export function ActivityEntryRow(props: Props) {
	const e = () => props.entry;

	return (
		<div style={{
			"margin-bottom": "0.35rem",
			display: "flex",
			"align-items": "baseline",
			gap: "4px",
			"flex-wrap": "wrap",
			"font-size": "0.75rem",
		}}>
			<span style={{ "font-weight": "500", color: "var(--color-text-secondary, #666)" }}>
				<ActorLabel actor={e().actor} userName={e().userName} />
			</span>
			<span>{actionLabel(e().action, e().type)}</span>

			{/* Nook-wide link: "Source → predicate → Target" */}
			<Show when={e().type === "link" && e().linkSourceTitle}>
				<NoteLinkEl
					title={e().linkSourceTitle!}
					noteId={e().linkSourceId}
					href={e().linkSourceId ? props.buildNoteHref?.(e().linkSourceId!) : undefined}
					onNoteHover={props.onNoteHover}
					onNoteLeave={props.onNoteLeave}
				/>
				<span style={{ color: "var(--color-text-muted)" }}>
					{e().linkLabel || "→"}
				</span>
				<NoteLinkEl
					title={e().linkTargetTitle || "?"}
					noteId={e().linkTargetId}
					href={e().linkTargetId ? props.buildNoteHref?.(e().linkTargetId!) : undefined}
					onNoteHover={props.onNoteHover}
					onNoteLeave={props.onNoteLeave}
				/>
			</Show>

			{/* Note-specific link: "this note → predicate → OtherNote" */}
			<Show when={e().type === "link" && !e().linkSourceTitle && e().linkedNoteTitle}>
				<Show when={e().linkLabel}>
					<span style={{ color: "var(--color-text-muted)" }}>{e().linkLabel}</span>
				</Show>
				<NoteLinkEl
					title={e().linkedNoteTitle!}
					noteId={e().linkedNoteId}
					href={e().linkedNoteId ? props.buildNoteHref?.(e().linkedNoteId!) : undefined}
					onNoteHover={props.onNoteHover}
					onNoteLeave={props.onNoteLeave}
				/>
			</Show>

			{/* Note entry: version badge */}
			<Show when={e().type === "note" && e().version}>
				<span
					style={{
						display: "inline-block",
						padding: "1px 6px",
						"border-radius": "999px",
						background: "var(--color-bg-tertiary, #f3f4f6)",
						"font-size": "0.65rem",
						"font-weight": "500",
						color: "var(--color-text-muted)",
						cursor: props.onViewVersion ? "pointer" : "default",
						transition: "background 0.15s",
					}}
					onClick={() => {
						if (props.onViewVersion && e().version) {
							props.onViewVersion(e().version!);
						}
					}}
					title={props.onViewVersion ? `View version ${e().version}` : undefined}
				>
					v{e().version}
				</span>
			</Show>

			{/* Note entry with title (for nook-wide note edits) */}
			<Show when={e().type === "note" && e().linkedNoteTitle}>
				<NoteLinkEl
					title={e().linkedNoteTitle!}
					noteId={e().linkedNoteId}
					href={e().linkedNoteId ? props.buildNoteHref?.(e().linkedNoteId!) : undefined}
					onNoteHover={props.onNoteHover}
					onNoteLeave={props.onNoteLeave}
				/>
			</Show>

			<TimeAgo date={e().createdAt} />
		</div>
	);
}
