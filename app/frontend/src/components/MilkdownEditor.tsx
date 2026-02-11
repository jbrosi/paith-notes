import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { createEffect, onCleanup, onMount } from "solid-js";

export type MilkdownEditorProps = {
	value: string;
	onChange: (value: string) => void;
	readonly?: boolean;
};

export function MilkdownEditor(props: MilkdownEditorProps) {
	let rootEl!: HTMLDivElement;
	let crepe: Crepe | null = null;
	let lastMarkdownFromEditor = props.value;

	const destroy = () => {
		if (crepe) {
			crepe.destroy();
			crepe = null;
		}
	};

	const create = async (defaultValue: string) => {
		rootEl.innerHTML = "";
		lastMarkdownFromEditor = defaultValue;

		crepe = new Crepe({
			root: rootEl,
			defaultValue,
		});

		crepe.on((listener) => {
			listener.markdownUpdated(() => {
				const markdown = crepe?.getMarkdown() ?? "";
				lastMarkdownFromEditor = markdown;
				props.onChange(markdown);
			});
		});

		await crepe.create();
		if (props.readonly) {
			crepe.setReadonly(true);
		}
	};

	onMount(() => {
		void create(props.value);
	});

	createEffect(() => {
		if (!crepe) {
			return;
		}
		crepe.setReadonly(Boolean(props.readonly));
	});

	createEffect(() => {
		const nextValue = props.value;
		if (!crepe) {
			return;
		}
		if (nextValue === lastMarkdownFromEditor) {
			return;
		}

		destroy();
		void create(nextValue);
	});

	onCleanup(() => {
		destroy();
	});

	return <div ref={rootEl} />;
}
