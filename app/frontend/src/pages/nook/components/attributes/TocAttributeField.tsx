import { createMemo, createSignal, For, Show } from "solid-js";
import type { NookStore } from "../../store";
import type { TypeAttribute } from "../../types";

export function TocAttributeField(props: {
	attr: TypeAttribute;
	store: NookStore;
	fullscreen?: boolean;
}) {
	const typeMaxDepth = () => Number(props.attr.config.max_depth ?? 6);

	// Per-note override: attribute value can be { max_depth: N }
	const noteOverride = () => {
		const val = props.store.noteAttributes?.()[props.attr.id];
		if (typeof val === "object" && val !== null && "max_depth" in (val as Record<string, unknown>)) {
			return Number((val as Record<string, unknown>).max_depth);
		}
		return 0;
	};

	const maxDepth = () => noteOverride() || typeMaxDepth();

	const headings = createMemo(() => {
		const all = props.store.noteHeadings();
		if (all.length === 0) return [];
		const minLevel = Math.min(...all.map((h) => h.level));
		const depth = maxDepth();
		return all.filter((h) => h.level - minLevel < depth);
	});

	const [open, setOpen] = createSignal(true);

	const scrollToHeading = (text: string) => {
		const container = document.querySelector("[data-note-content]") ?? document.body;
		const els = container.querySelectorAll("h1, h2, h3, h4, h5, h6");
		for (const el of els) {
			if (el.textContent?.trim() === text) {
				el.scrollIntoView({ behavior: "smooth", block: "start" });
				return;
			}
		}
	};

	return (
		<Show when={headings().length > 0 && props.store.mode() !== "edit"}>
			<div
				style={{
					"margin-top": "8px",
					border: "1px solid var(--color-border-light, #e5e7eb)",
					"border-radius": "6px",
					overflow: "hidden",
				}}
			>
				<button
					type="button"
					onClick={() => setOpen(!open())}
					style={{
						width: "100%",
						padding: "6px 10px",
						border: "none",
						background: "var(--color-bg-secondary, #f9fafb)",
						cursor: "pointer",
						display: "flex",
						"align-items": "center",
						gap: "4px",
						"font-size": "0.7rem",
						"font-weight": "600",
						color: "var(--color-text-secondary, #6b7280)",
					}}
				>
					<span style={{ "font-size": "0.6rem" }}>{open() ? "▼" : "▶"}</span>
					{props.attr.name}
					<span
						style={{
							"margin-left": "auto",
							"font-weight": "400",
							color: "var(--color-text-muted)",
						}}
					>
						{headings().length}
					</span>
				</button>
				<Show when={open()}>
					<div style={{ padding: "4px 0" }}>
						<For each={headings()}>
							{(h) => {
								const minLevel = () => Math.min(...props.store.noteHeadings().map((x) => x.level));
								return (
									<button
										type="button"
										onClick={() => scrollToHeading(h.text)}
										style={{
											display: "block",
											width: "100%",
											padding: "3px 10px",
											"padding-left": `${10 + (h.level - minLevel()) * 14}px`,
											border: "none",
											background: "none",
											"text-align": "left",
											cursor: "pointer",
											"font-size": "0.75rem",
											color: "var(--color-text-secondary)",
											"white-space": "nowrap",
											overflow: "hidden",
											"text-overflow": "ellipsis",
										}}
										title={h.text}
									>
										{h.text}
									</button>
								);
							}}
						</For>
					</div>
				</Show>
			</div>
		</Show>
	);
}
