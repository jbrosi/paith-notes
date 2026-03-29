import { onCleanup, onMount, Show } from "solid-js";
import styles from "./LinkPopup.module.css";

type Props = {
	x: number;
	y: number;
	nookId: string;
	noteId: string;
	noteTitle?: string;
	noteType?: string;
	predicate?: string;
	onOpen: () => void;
	onRemove?: () => void;
	onClose: () => void;
};

export function LinkPopup(props: Props) {
	let el!: HTMLDivElement;

	onMount(() => {
		const onPointerDown = (e: PointerEvent) => {
			if (!el.contains(e.target as Node)) props.onClose();
		};
		const onKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape") props.onClose();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKeydown, true);
		onCleanup(() => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKeydown, true);
		});
	});

	const left = () => Math.min(props.x, window.innerWidth - 200);
	const top = () => props.y + 6;
	const shortId = () => props.noteId.slice(0, 8);
	const href = () =>
		`/nooks/${encodeURIComponent(props.nookId)}/notes/${encodeURIComponent(props.noteId)}`;

	return (
		<div
			ref={el}
			class={styles.popup}
			style={{ left: `${left()}px`, top: `${top()}px` }}
		>
			<a
				href={href()}
				class={styles.infoBtn}
				onClick={(e) => {
					if (!e.ctrlKey && !e.metaKey) {
						e.preventDefault();
						props.onOpen();
						props.onClose();
					} else {
						props.onClose();
					}
				}}
			>
				<div class={styles.infoContent}>
					<div>
						<div class={styles.title}>{props.noteTitle ?? props.noteId}</div>
						<div class={styles.meta}>
							<Show when={props.predicate}>
								<span>{props.predicate}</span>
								<span class={styles.dot}>·</span>
							</Show>
							<Show when={props.noteType}>
								<span>{props.noteType}</span>
								<span class={styles.dot}>·</span>
							</Show>
							<span class={styles.uuid}>{shortId()}…</span>
						</div>
					</div>
					<svg
						class={styles.openIcon}
						width="14"
						height="14"
						viewBox="0 0 14 14"
						fill="none"
						xmlns="http://www.w3.org/2000/svg"
					>
						<title>Open note</title>
						<path
							d="M2 7h10M7 2l5 5-5 5"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</div>
			</a>
			<Show when={props.onRemove}>
				<div class={styles.divider} />
				<button
					type="button"
					class={styles.btn}
					onClick={() => {
						props.onRemove?.();
						props.onClose();
					}}
				>
					Remove link
				</button>
			</Show>
		</div>
	);
}
