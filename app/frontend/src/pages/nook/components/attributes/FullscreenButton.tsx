import { useNavigate } from "@solidjs/router";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";

/** Small icon button that navigates to the fullscreen view for an attribute. */
export function FullscreenButton(props: {
	attr: TypeAttribute;
	store: NookStore;
}) {
	const navigate = useNavigate();

	const open = () => {
		const nookId = props.store.nookId();
		const noteId = props.store.selectedId();
		const key = props.attr.key;
		if (nookId && noteId && key) {
			navigate(
				`/nooks/${encodeURIComponent(nookId)}/notes/${encodeURIComponent(noteId)}/attr/${encodeURIComponent(key)}`,
			);
		}
	};

	return (
		<button
			type="button"
			onClick={open}
			title="Open fullscreen"
			style={{
				border: "none",
				background: "none",
				cursor: "pointer",
				padding: "2px",
				color: "var(--color-text-muted)",
				"font-size": "14px",
				"line-height": "1",
				opacity: "0.6",
			}}
			onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
			onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; }}
		>
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="M8 3H5a2 2 0 0 0-2 2v3" />
				<path d="M21 8V5a2 2 0 0 0-2-2h-3" />
				<path d="M3 16v3a2 2 0 0 0 2 2h3" />
				<path d="M16 21h3a2 2 0 0 0 2-2v-3" />
			</svg>
		</button>
	);
}
