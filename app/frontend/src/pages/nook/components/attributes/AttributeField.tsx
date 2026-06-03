import { For, Show } from "solid-js";
import type { TypeAttribute } from "../../types";

export function AttributeField(props: {
	attr: TypeAttribute;
	value: unknown;
	onChange: (v: unknown) => void;
	disabled: boolean;
}) {
	const strVal = () => String(props.value ?? "");
	const numVal = () =>
		typeof props.value === "number" ? props.value : Number(props.value) || 0;

	const labelStyle = {
		"font-size": "12px",
		color: "var(--color-text-secondary)",
		"margin-bottom": "2px",
	};
	const inputStyle = {
		width: "100%",
		padding: "6px 8px",
		"box-sizing": "border-box" as const,
		"font-size": "13px",
	};

	const display = () => (props.attr.config.display as string) ?? "";

	switch (props.attr.kind) {
		case "text":
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					{display() === "paragraph" ? (
						<textarea
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							disabled={props.disabled}
							rows={4}
							style={inputStyle}
						/>
					) : (
						<input
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							disabled={props.disabled}
							style={inputStyle}
						/>
					)}
				</label>
			);

		case "number": {
			if (display() === "rating") {
				const maxVal = Number(props.attr.config.max ?? 5) || 5;
				return (
					<div>
						<div style={labelStyle}>{props.attr.name}</div>
						<div style={{ display: "flex", gap: "2px" }}>
							{Array.from({ length: maxVal }, (_, i) => i + 1).map((n) => (
								<button
									type="button"
									disabled={props.disabled}
									onClick={() => props.onChange(numVal() === n ? 0 : n)}
									style={{
										border: "none",
										background: "none",
										cursor: props.disabled ? "default" : "pointer",
										"font-size": "20px",
										padding: "0 1px",
										color: n <= numVal() ? "var(--seed-warning)" : "var(--color-border-light)",
									}}
								>
									★
								</button>
							))}
							<span style={{ "font-size": "12px", color: "var(--color-text-muted)", "margin-left": "4px", "align-self": "center" }}>
								{numVal() > 0 ? numVal() : ""}
							</span>
						</div>
					</div>
				);
			}
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<input
						type="number"
						value={numVal()}
						onInput={(e) => props.onChange(Number(e.currentTarget.value))}
						disabled={props.disabled}
						style={inputStyle}
					/>
				</label>
			);
		}

		case "boolean":
			return (
				<label
					style={{
						display: "flex",
						"align-items": "center",
						gap: "6px",
						"font-size": "13px",
					}}
				>
					<input
						type="checkbox"
						checked={Boolean(props.value)}
						onChange={(e) => props.onChange(e.currentTarget.checked)}
						disabled={props.disabled}
					/>
					{props.attr.name}
				</label>
			);

		case "date":
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<input
						type="date"
						value={strVal()}
						onInput={(e) => props.onChange(e.currentTarget.value)}
						disabled={props.disabled}
						style={inputStyle}
					/>
				</label>
			);

		case "date_range": {
			const rangeVal = () => {
				if (typeof props.value === "object" && props.value !== null) {
					const v = props.value as { from?: string; to?: string };
					return { from: v.from ?? "", to: v.to ?? "" };
				}
				return { from: "", to: "" };
			};
			return (
				<div>
					<div style={labelStyle}>{props.attr.name}</div>
					<div style={{ display: "flex", gap: "6px" }}>
						<input
							type="date"
							value={rangeVal().from}
							onInput={(e) =>
								props.onChange({ ...rangeVal(), from: e.currentTarget.value })
							}
							disabled={props.disabled}
							style={{ ...inputStyle, flex: 1 }}
						/>
						<span style={{ "align-self": "center", color: "var(--color-text-muted)" }}>to</span>
						<input
							type="date"
							value={rangeVal().to}
							onInput={(e) =>
								props.onChange({ ...rangeVal(), to: e.currentTarget.value })
							}
							disabled={props.disabled}
							style={{ ...inputStyle, flex: 1 }}
						/>
					</div>
				</div>
			);
		}

		case "select": {
			const options = Array.isArray(props.attr.config.options)
				? (props.attr.config.options as string[])
				: [];
			return (
				<label>
					<div style={labelStyle}>{props.attr.name}</div>
					<select
						value={strVal()}
						onChange={(e) => props.onChange(e.currentTarget.value)}
						disabled={props.disabled}
						style={inputStyle}
					>
						<option value="">(none)</option>
						<For each={options}>
							{(opt) => <option value={opt}>{opt}</option>}
						</For>
					</select>
				</label>
			);
		}

		case "multi_select": {
			const options = Array.isArray(props.attr.config.options)
				? (props.attr.config.options as string[])
				: [];
			const selected = () => {
				if (Array.isArray(props.value)) return props.value as string[];
				return [];
			};
			const toggle = (opt: string) => {
				const cur = selected();
				if (cur.includes(opt)) {
					props.onChange(cur.filter((v) => v !== opt));
				} else {
					props.onChange([...cur, opt]);
				}
			};
			return (
				<div>
					<div style={labelStyle}>{props.attr.name}</div>
					<Show
						when={!props.disabled}
						fallback={
							<div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
								<For each={selected()}>
									{(v) => (
										<span
											style={{
												padding: "2px 8px",
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
								<Show when={selected().length === 0}>
									<span style={{ "font-size": "0.75rem", color: "var(--color-text-muted)" }}>(none)</span>
								</Show>
							</div>
						}
					>
						<div style={{ display: "flex", gap: "4px", "flex-wrap": "wrap" }}>
							<For each={options}>
								{(opt) => {
									const isSelected = () => selected().includes(opt);
									return (
										<button
											type="button"
											onClick={() => toggle(opt)}
											style={{
												padding: "2px 8px",
												"border-radius": "999px",
												border: "1px solid",
												"border-color": isSelected() ? "var(--color-primary-border, #bae6fd)" : "var(--color-border-light, #e5e7eb)",
												background: isSelected() ? "var(--color-primary-bg, #eff6ff)" : "transparent",
												"font-size": "0.7rem",
												color: isSelected() ? "var(--color-primary, #3b82f6)" : "var(--color-text-secondary)",
												cursor: "pointer",
											}}
										>
											{opt}
										</button>
									);
								}}
							</For>
						</div>
					</Show>
				</div>
			);
		}

		case "url":
			return (
				<div>
					<div style={labelStyle}>{props.attr.name}</div>
					<Show
						when={!props.disabled}
						fallback={
							<Show
								when={strVal()}
								fallback={<span style={{ "font-size": "0.75rem", color: "var(--color-text-muted)" }}>(none)</span>}
							>
								<a
									href={strVal()}
									target="_blank"
									rel="noopener noreferrer"
									style={{ "font-size": "0.8rem", color: "var(--link-color, #0066cc)", "word-break": "break-all" }}
								>
									{strVal()}
								</a>
							</Show>
						}
					>
						<input
							type="url"
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							placeholder="https://..."
							style={inputStyle}
						/>
					</Show>
				</div>
			);

		default:
			return null;
	}
}
