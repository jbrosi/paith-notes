import type { JSX } from "solid-js";
import type { TypeAttribute } from "../../types";
import { AttributeDiffValue } from "./AttributeDiffValue";

/**
 * Renders a diff for a single attribute: old value → new value.
 * Attribute kinds can register custom diff renderers via DIFF_RENDERERS.
 */
export function AttributeDiff(props: {
	attr: TypeAttribute;
	oldValue: unknown;
	newValue: unknown;
}): JSX.Element {
	const customRenderer = DIFF_RENDERERS[props.attr.kind];
	if (customRenderer) {
		const result = customRenderer(props.attr, props.oldValue, props.newValue);
		if (result) return result;
	}

	return (
		<div
			style={{
				display: "flex",
				"align-items": "baseline",
				gap: "8px",
				padding: "4px 0",
			}}
		>
			<span
				style={{
					"font-size": "0.75rem",
					"font-weight": "600",
					color: "var(--color-text-secondary)",
					"min-width": "80px",
					"flex-shrink": "0",
				}}
			>
				{props.attr.name}
			</span>
			<span
				style={{
					display: "inline-flex",
					"align-items": "baseline",
					gap: "6px",
					"flex-wrap": "wrap",
					"min-width": "0",
				}}
			>
				<span
					style={{
						"text-decoration": "line-through",
						color: "var(--color-danger, #ef4444)",
						opacity: "0.8",
					}}
				>
					<AttributeDiffValue attr={props.attr} value={props.oldValue} />
				</span>
				<span
					style={{ color: "var(--color-text-muted)", "font-size": "0.75rem" }}
				>
					→
				</span>
				<span
					style={{
						color: "var(--color-success, #22c55e)",
					}}
				>
					<AttributeDiffValue attr={props.attr} value={props.newValue} />
				</span>
			</span>
		</div>
	);
}

/**
 * Registry for custom diff renderers per attribute kind.
 * Each renderer receives the attribute definition, old value, and new value.
 * Return a JSX element. If not registered, the default old → new display is used.
 */
type DiffRenderer = (
	attr: TypeAttribute,
	oldValue: unknown,
	newValue: unknown,
) => JSX.Element | null;

const DIFF_RENDERERS: Partial<Record<string, DiffRenderer>> = {
	// Rating: show both star rows
	number: (attr, oldValue, newValue) => {
		const display = (attr.config.display as string) ?? "";
		if (display !== "rating") return null;

		const maxVal = Number(attr.config.max ?? 5) || 5;
		const oldNum =
			typeof oldValue === "number" ? oldValue : Number(oldValue) || 0;
		const newNum =
			typeof newValue === "number" ? newValue : Number(newValue) || 0;

		const stars = (n: number, color: string) => (
			<span>
				{Array.from({ length: maxVal }, (_, i) => (
					<span
						style={{
							color: i < n ? color : "var(--color-border-light)",
							"font-size": "0.85rem",
						}}
					>
						★
					</span>
				))}
			</span>
		);

		return (
			<div
				style={{
					display: "flex",
					"align-items": "center",
					gap: "8px",
					padding: "4px 0",
				}}
			>
				<span
					style={{
						"font-size": "0.75rem",
						"font-weight": "600",
						color: "var(--color-text-secondary)",
						"min-width": "80px",
						"flex-shrink": "0",
					}}
				>
					{attr.name}
				</span>
				<span style={{ opacity: "0.6" }}>
					{stars(oldNum, "var(--seed-warning)")}
				</span>
				<span
					style={{ color: "var(--color-text-muted)", "font-size": "0.75rem" }}
				>
					→
				</span>
				{stars(newNum, "var(--seed-warning)")}
			</div>
		);
	},
};
