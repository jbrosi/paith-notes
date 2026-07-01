import { A } from "@solidjs/router";
import { For, Show } from "solid-js";
import type { NotePreviewController } from "../../pages/nook/NookContext";
import { Button } from "../Button";
import type { ToolUse } from "./ChatMessage";
import styles from "./ToolApproval.module.css";

const DESTRUCTIVE_TOOLS = new Set(["delete_note", "delete_note_link"]);
const WRITE_TOOLS = new Set([
	"create_note",
	"update_note",
	"edit_note",
	"edit_note_agent",
	"create_note_link",
	"generate_image",
	"open_note",
	"start_new_chat",
]);

function toolKind(name: string): "destructive" | "write" | "read" {
	if (DESTRUCTIVE_TOOLS.has(name)) return "destructive";
	if (WRITE_TOOLS.has(name)) return "write";
	return "read";
}

/** Inline-diff: split each line that differs into a `-` + `+` pair so
 * the user can scan the swap at a glance. For multi-line edits we keep
 * it dumb (one block of `-old` followed by one block of `+new`) — fancy
 * intra-line diffing would over-promise on accuracy. */
function diffBlocks(
	oldStr: string,
	newStr: string,
): Array<{ kind: "del" | "add"; line: string }> {
	const out: Array<{ kind: "del" | "add"; line: string }> = [];
	for (const line of oldStr.split("\n")) out.push({ kind: "del", line });
	for (const line of newStr.split("\n")) out.push({ kind: "add", line });
	return out;
}

type EditSpec = {
	old_string?: unknown;
	new_string?: unknown;
	replace_all?: unknown;
};

/** Normalise an edit_note tool input into a flat list of edits regardless of
 * whether the model used the new `edits: [...]` array shape or the legacy
 * top-level `old_string`/`new_string` shape. */
function extractEdits(
	input: Record<string, unknown>,
): Array<{ oldStr: string; newStr: string; replaceAll: boolean }> {
	const arr = Array.isArray(input.edits) ? (input.edits as EditSpec[]) : null;
	if (arr) {
		return arr.map((e) => ({
			oldStr: String(e?.old_string ?? ""),
			newStr: String(e?.new_string ?? ""),
			replaceAll: e?.replace_all === true,
		}));
	}
	if (typeof input.old_string === "string") {
		return [
			{
				oldStr: String(input.old_string),
				newStr: String(input.new_string ?? ""),
				replaceAll: input.replace_all === true,
			},
		];
	}
	return [];
}

type DisplayName = { label: string; url?: string };

type Props = {
	tools: ToolUse[];
	displayNames: Record<string, DisplayName>;
	onApprove: () => void;
	onDeny: () => void;
	disabled: boolean;
	notePreview?: NotePreviewController;
	nookName?: string;
};

function InputValue(props: {
	value: unknown;
	displayNames: Record<string, DisplayName>;
	notePreview?: NotePreviewController;
}) {
	const str = String(props.value ?? "");
	const resolved = () => props.displayNames[str];
	/** Only show preview for values that resolved to a display name (i.e. note IDs) */
	const hoverHandlers = () => {
		if (!resolved() || !props.notePreview) return {};
		return {
			onMouseEnter: (e: MouseEvent) => {
				const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
				props.notePreview?.show(str, rect.left, rect.bottom);
			},
			onMouseLeave: () => props.notePreview?.hide(),
		};
	};
	return (
		<span class={styles.inputVal} {...hoverHandlers()}>
			{resolved() ? (
				resolved()?.url ? (
					<A href={resolved()?.url ?? ""} class={styles.noteLink}>
						{resolved()?.label}
					</A>
				) : (
					<span class={styles.resolvedLabel}>{resolved()?.label}</span>
				)
			) : (
				str
			)}
		</span>
	);
}

export function ToolApproval(props: Props) {
	const hasDestructive = () =>
		props.tools.some((t) => toolKind(t.name) === "destructive");

	return (
		<div class={styles.container}>
			<p class={styles.title}>Claude wants to use tools:</p>
			<For each={props.tools}>
				{(t) => {
					const kind = toolKind(t.name);
					return (
						<div
							class={`${styles.toolItem} ${kind === "destructive" ? styles.destructive : kind === "write" ? styles.write : ""}`}
						>
							<Show when={t.name === "search_agent"}>
								<div class={styles.searchAgentScope}>
									Will search notes in:{" "}
									<strong>{props.nookName || "current nook"}</strong> + memories
								</div>
							</Show>
							<div class={styles.toolName}>
								{t.name}
								{kind === "destructive" && (
									<span class={`${styles.badge} ${styles.badgeDestructive}`}>
										irreversible
									</span>
								)}
								{kind === "write" && (
									<span class={`${styles.badge} ${styles.badgeWrite}`}>
										write
									</span>
								)}
							</div>
							<Show
								when={t.name === "edit_note"}
								fallback={
									<div class={styles.inputTable}>
										<For each={Object.entries(t.input)}>
											{([key, value]) => (
												<div class={styles.inputRow}>
													<span class={styles.inputKey}>{key}</span>
													<InputValue
														value={value}
														displayNames={props.displayNames}
														notePreview={props.notePreview}
													/>
												</div>
											)}
										</For>
									</div>
								}
							>
								{/* edit_note: render a real diff per edit instead of
								    dumping multi-line old/new strings as raw values. */}
								<div class={styles.inputTable}>
									<div class={styles.inputRow}>
										<span class={styles.inputKey}>note</span>
										<InputValue
											value={t.input.note_id}
											displayNames={props.displayNames}
											notePreview={props.notePreview}
										/>
									</div>
								</div>
								<For each={extractEdits(t.input)}>
									{(edit, i) => {
										const total = extractEdits(t.input).length;
										return (
											<div class={styles.diffWrap}>
												<Show when={total > 1 || edit.replaceAll}>
													<div class={styles.diffHeader}>
														{total > 1 ? `edit ${i() + 1}` : ""}
														{total > 1 && edit.replaceAll ? " · " : ""}
														{edit.replaceAll ? "replace all" : ""}
													</div>
												</Show>
												<pre class={styles.diffBlock}>
													<For each={diffBlocks(edit.oldStr, edit.newStr)}>
														{(b) => (
															<div
																class={
																	b.kind === "del"
																		? styles.diffDel
																		: styles.diffAdd
																}
															>
																<span class={styles.diffMarker}>
																	{b.kind === "del" ? "-" : "+"}
																</span>
																{b.line || " "}
															</div>
														)}
													</For>
												</pre>
											</div>
										);
									}}
								</For>
							</Show>
						</div>
					);
				}}
			</For>
			<div class={styles.actions}>
				<Button
					onClick={props.onApprove}
					disabled={props.disabled}
					size="small"
					variant={hasDestructive() ? "danger" : "primary"}
				>
					{hasDestructive() ? "Allow (irreversible)" : "Allow all"}
				</Button>
				<Button
					onClick={props.onDeny}
					variant="secondary"
					disabled={props.disabled}
					size="small"
				>
					Deny
				</Button>
			</div>
		</div>
	);
}
