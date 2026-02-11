import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { createEffect, onCleanup, onMount } from "solid-js";

export type MilkdownEditorProps = {
	value: string;
	onChange: (value: string) => void;
	readonly?: boolean;
	onNoteLinkClick?: (noteId: string) => void;
	resolveEmbeddedImageSrc?: (noteId: string) => Promise<string | null>;
	uploadEmbeddedImage?: (file: File) => Promise<string | null>;
};

export function MilkdownEditor(props: MilkdownEditorProps) {
	let rootEl!: HTMLDivElement;
	let crepe: Crepe | null = null;
	let lastMarkdownFromEditor = props.value;
	let onRootClick: ((e: MouseEvent) => void) | null = null;
	let onRootChange: ((e: Event) => void) | null = null;
	let embedObserver: MutationObserver | null = null;
	let embedResolveTimer: number | null = null;
	const pendingUploadedFiles: File[] = [];

	const destroy = () => {
		if (embedResolveTimer !== null) {
			window.clearTimeout(embedResolveTimer);
			embedResolveTimer = null;
		}
		if (embedObserver) {
			embedObserver.disconnect();
			embedObserver = null;
		}
		if (onRootClick) {
			rootEl.removeEventListener("click", onRootClick);
			onRootClick = null;
		}
		if (onRootChange) {
			rootEl.removeEventListener("change", onRootChange, true);
			onRootChange = null;
		}
		if (crepe) {
			crepe.destroy();
			crepe = null;
		}
	};

	const resolveEmbedsSoon = () => {
		if (!props.resolveEmbeddedImageSrc && !props.uploadEmbeddedImage) return;
		if (embedResolveTimer !== null) return;
		embedResolveTimer = window.setTimeout(() => {
			embedResolveTimer = null;
			void resolveEmbeds();
		}, 0);
	};

	const replaceInMarkdownAndReload = (fromSrc: string, toSrc: string) => {
		const current = crepe?.getMarkdown() ?? lastMarkdownFromEditor;
		if (!current.includes(fromSrc)) {
			return;
		}
		const next = current.split(fromSrc).join(toSrc);
		if (next === current) {
			return;
		}

		lastMarkdownFromEditor = next;
		props.onChange(next);

		// Ensure the underlying document is updated (DOM mutations alone won't persist).
		destroy();
		void create(next);
	};

	const resolveEmbeds = async () => {
		const uploader = props.uploadEmbeddedImage;
		if (uploader) {
			const images = rootEl.querySelectorAll("img");
			for (const img of images) {
				const src = img.getAttribute("src") ?? "";
				if (!(src.startsWith("blob:") || src.startsWith("data:"))) continue;
				if (img.dataset.noteUploaded === "1") continue;
				if (img.dataset.noteUploading === "1") continue;

				img.dataset.noteUploading = "1";
				try {
					const directFile = pendingUploadedFiles.shift();
					let file: File;
					if (directFile) {
						file = directFile;
					} else {
						const res = await fetch(src);
						if (!res.ok) continue;
						const blob = await res.blob();
						const mime = blob.type || "application/octet-stream";
						const ext = mime.startsWith("image/")
							? mime.slice("image/".length)
							: "bin";
						const rawName = (
							img.getAttribute("alt") ??
							img.getAttribute("title") ??
							""
						).trim();
						const baseName = rawName
							.replace(/\.[a-z0-9]+$/i, "")
							.replace(/[^a-z0-9_-]+/gi, "-")
							.replace(/-+/g, "-")
							.replace(/^-|-$/g, "");
						const finalBase =
							baseName !== "" ? baseName : `embedded-${Date.now()}`;
						file = new File([blob], `${finalBase}.${ext}`, { type: mime });
					}
					const noteId = await uploader(file);
					if (!noteId) continue;

					img.dataset.noteUploaded = "1";
					img.dataset.noteResolved = "0";
					img.removeAttribute("data-note-resolved");
					const noteSrc = `note:${noteId}`;
					img.setAttribute("src", noteSrc);
					replaceInMarkdownAndReload(src, noteSrc);
				} finally {
					img.dataset.noteUploading = "0";
				}
			}
		}

		const resolver = props.resolveEmbeddedImageSrc;
		if (!resolver) return;

		const images = rootEl.querySelectorAll("img");
		for (const img of images) {
			const src = img.getAttribute("src") ?? "";
			if (!src.startsWith("note:")) continue;
			if (img.dataset.noteResolved === "1") continue;
			if (img.dataset.noteResolving === "1") continue;

			const noteId = src.slice("note:".length).trim();
			if (noteId === "") continue;

			img.dataset.noteResolving = "1";
			try {
				const resolved = await resolver(noteId);
				if (resolved) {
					img.dataset.noteOriginalSrc = src;
					img.setAttribute("src", resolved);
					img.dataset.noteResolved = "1";
				}
			} finally {
				img.dataset.noteResolving = "0";
			}
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

		onRootChange = (e: Event) => {
			const target = e.target;
			if (!(target instanceof HTMLInputElement)) return;
			if (target.type !== "file") return;
			const files = target.files;
			if (!files || files.length === 0) return;
			for (const f of Array.from(files)) {
				pendingUploadedFiles.push(f);
			}
			resolveEmbedsSoon();
		};
		rootEl.addEventListener("change", onRootChange, true);

		crepe = new Crepe({
			root: rootEl,
			defaultValue,
		});

		crepe.on((listener) => {
			listener.markdownUpdated(() => {
				const markdown = crepe?.getMarkdown() ?? "";
				lastMarkdownFromEditor = markdown;
				props.onChange(markdown);
				resolveEmbedsSoon();
			});
		});

		await crepe.create();
		if (props.readonly) {
			crepe.setReadonly(true);
		}

		embedObserver = new MutationObserver(() => {
			resolveEmbedsSoon();
		});
		embedObserver.observe(rootEl, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["src"],
		});

		resolveEmbedsSoon();
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
