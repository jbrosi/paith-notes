import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { createEffect, onCleanup, onMount } from "solid-js";

export type MilkdownEditorProps = {
	value: string;
	onChange: (value: string) => void;
	readonly?: boolean;
	onNoteLinkClick?: (noteId: string) => void;
};

export function MilkdownEditor(props: MilkdownEditorProps) {
	let rootEl!: HTMLDivElement;
	let crepe: Crepe | null = null;
	let lastMarkdownFromEditor = props.value;
	let onRootClick: ((e: MouseEvent) => void) | null = null;

	const destroy = () => {
		if (onRootClick) {
			rootEl.removeEventListener("click", onRootClick);
			onRootClick = null;
		}
		if (crepe) {
			crepe.destroy();
			crepe = null;
		}
	};

	const create = async (defaultValue: string) => {
		rootEl.innerHTML = "";
		lastMarkdownFromEditor = defaultValue;

		onRootClick = (e: MouseEvent) => {
			const target = e.target;
			if (!(target instanceof Element)) {
				return;
			}
			const anchor = target.closest("a");
			if (!(anchor instanceof HTMLAnchorElement)) {
				return;
			}
			const href = anchor.getAttribute("href") ?? "";
			if (!href.startsWith("note:")) {
				return;
			}

			e.preventDefault();
			e.stopPropagation();
			const noteId = href.slice("note:".length).trim();
			if (noteId !== "") {
				props.onNoteLinkClick?.(noteId);
			}
		};
		rootEl.addEventListener("click", onRootClick);

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
