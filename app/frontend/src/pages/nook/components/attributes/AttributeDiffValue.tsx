import { For } from "solid-js";
import type { TypeAttribute } from "../../types";

/**
 * Read-only compact renderer for a single attribute value.
 * Used in diff views to display old/new values.
 */
export function AttributeDiffValue(props: {
	attr: TypeAttribute;
	value: unknown;
}) {
	const val = () => props.value;
	const strVal = () => String(val() ?? "");
	const display = () => (props.attr.config.display as string) ?? "";

	const emptyStyle = {
		"font-size": "0.8rem",
		color: "var(--color-text-muted)",
		"font-style": "italic" as const,
	};

	if (val() === undefined || val() === null || val() === "") {
		return <span style={emptyStyle}>(empty)</span>;
	}

	switch (props.attr.kind) {
		case "text":
			return <span style={{ "font-size": "0.8rem" }}>{strVal()}</span>;

		case "number": {
			if (display() === "rating") {
				const maxVal = Number(props.attr.config.max ?? 5) || 5;
				const numVal =
					typeof val() === "number" ? (val() as number) : Number(val()) || 0;
				return (
					<span style={{ "font-size": "0.85rem" }}>
						{Array.from({ length: maxVal }, (_, i) => (
							<span
								style={{
									color:
										i < numVal
											? "var(--seed-warning)"
											: "var(--color-border-light)",
								}}
							>
								★
							</span>
						))}
						<span
							style={{
								"font-size": "0.75rem",
								color: "var(--color-text-muted)",
								"margin-left": "4px",
							}}
						>
							{numVal}
						</span>
					</span>
				);
			}
			return <span style={{ "font-size": "0.8rem" }}>{strVal()}</span>;
		}

		case "boolean":
			return (
				<span style={{ "font-size": "0.8rem" }}>{val() ? "Yes" : "No"}</span>
			);

		case "date":
			return <span style={{ "font-size": "0.8rem" }}>{strVal()}</span>;

		case "date_range": {
			const rv = val() as { from?: string; to?: string } | null;
			if (!rv) return <span style={emptyStyle}>(empty)</span>;
			return (
				<span style={{ "font-size": "0.8rem" }}>
					{rv.from || "?"} → {rv.to || "?"}
				</span>
			);
		}

		case "select":
			return <span style={{ "font-size": "0.8rem" }}>{strVal()}</span>;

		case "multi_select": {
			const items = Array.isArray(val()) ? (val() as string[]) : [];
			if (items.length === 0) return <span style={emptyStyle}>(empty)</span>;
			return (
				<span
					style={{ display: "inline-flex", gap: "4px", "flex-wrap": "wrap" }}
				>
					<For each={items}>
						{(v) => (
							<span
								style={{
									padding: "1px 6px",
									"border-radius": "999px",
									background: "var(--color-primary-bg, #eff6ff)",
									border: "1px solid var(--color-primary-border, #bae6fd)",
									"font-size": "0.7rem",
									color: "var(--color-primary, #3b82f6)",
								}}
							>
								{v}
							</span>
						)}
					</For>
				</span>
			);
		}

		case "url":
			return (
				<a
					href={strVal()}
					target="_blank"
					rel="noopener noreferrer"
					style={{
						"font-size": "0.8rem",
						color: "var(--link-color, #0066cc)",
						"word-break": "break-all" as const,
					}}
				>
					{strVal()}
				</a>
			);

		case "graph": {
			const gv = val() as Record<string, unknown> | null;
			if (!gv) return <span style={emptyStyle}>(empty)</span>;
			const parts: string[] = [];
			if (gv.rootNoteId)
				parts.push(`root: ${String(gv.rootNoteId).slice(0, 8)}…`);
			if (gv.depth) parts.push(`depth: ${gv.depth}`);
			if (gv.layout) parts.push(`layout: ${gv.layout}`);
			return (
				<span
					style={{
						"font-size": "0.8rem",
						color: "var(--color-text-secondary)",
					}}
				>
					{parts.join(", ") || JSON.stringify(gv)}
				</span>
			);
		}

		default:
			// Fallback: JSON representation
			return (
				<span
					style={{
						"font-size": "0.75rem",
						"font-family": "monospace",
						color: "var(--color-text-secondary)",
					}}
				>
					{typeof val() === "object" ? JSON.stringify(val()) : strVal()}
				</span>
			);
	}
}
