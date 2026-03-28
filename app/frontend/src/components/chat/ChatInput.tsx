import { createSignal } from "solid-js";
import styles from "./ChatInput.module.css";

const MODELS = [
	{ value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ value: "claude-opus-4-6", label: "Opus 4.6" },
	{ value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

type Props = {
	onSend: (text: string, model: string) => void;
	disabled: boolean;
	model: string;
	onModelChange: (model: string) => void;
};

export function ChatInput(props: Props) {
	const [text, setText] = createSignal("");

	const submit = () => {
		const t = text().trim();
		if (!t || props.disabled) return;
		props.onSend(t, props.model);
		setText("");
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			submit();
		}
	};

	return (
		<div class={styles.form}>
			<div class={styles.row}>
				<textarea
					class={styles.textarea}
					value={text()}
					onInput={(e) => setText(e.currentTarget.value)}
					onKeyDown={onKeyDown}
					disabled={props.disabled}
					placeholder="Ask about your notes… (Enter to send)"
					rows={1}
				/>
				<button
					class={styles.sendBtn}
					type="button"
					onClick={submit}
					disabled={props.disabled || text().trim() === ""}
				>
					Send
				</button>
			</div>
			<select
				class={styles.modelSelect}
				value={props.model}
				onChange={(e) => props.onModelChange(e.currentTarget.value)}
				disabled={props.disabled}
			>
				{MODELS.map((m) => (
					<option value={m.value}>{m.label}</option>
				))}
			</select>
		</div>
	);
}
