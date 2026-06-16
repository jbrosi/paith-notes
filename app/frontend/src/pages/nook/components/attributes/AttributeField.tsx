import { For, Show } from "solid-js";
import type { TypeAttribute } from "../../types";

/**
 * Humanise a raw millisecond count for the number kind's
 * display="duration" variant. Crosses the boundaries that actually
 * matter for our use cases: an OpenAI call ranging from a few hundred
 * ms to a few minutes.
 */
function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
	if (ms < 1000) return `${Math.round(ms)} ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
	if (ms < 3_600_000) {
		const mins = Math.floor(ms / 60_000);
		const secs = Math.round((ms % 60_000) / 1000);
		return secs ? `${mins} min ${secs} s` : `${mins} min`;
	}
	if (ms < 86_400_000) {
		const hrs = Math.floor(ms / 3_600_000);
		const mins = Math.round((ms % 3_600_000) / 60_000);
		return mins ? `${hrs} h ${mins} min` : `${hrs} h`;
	}
	const days = Math.floor(ms / 86_400_000);
	const hrs = Math.round((ms % 86_400_000) / 3_600_000);
	return hrs ? `${days} d ${hrs} h` : `${days} d`;
}

/**
 * Format a decimal as a currency string. Uses up to 4 fraction digits
 * because AI-generation costs are routinely sub-cent ($0.0042) and a
 * 2-digit rounding would mislead.
 */
function formatCurrency(value: number, currency: string): string {
	if (!Number.isFinite(value)) return "";
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 4,
		}).format(value);
	} catch {
		// Unknown currency code — fall back to plain decimal + code so the
		// value is still readable when Intl rejects the input.
		return `${value.toFixed(4)} ${currency}`;
	}
}

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
		case "text": {
			const inputId = `attr-${props.attr.id}`;
			return (
				<label for={inputId}>
					<div style={labelStyle}>{props.attr.name}</div>
					{display() === "paragraph" ? (
						<textarea
							id={inputId}
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							disabled={props.disabled}
							rows={4}
							style={inputStyle}
						/>
					) : (
						<input
							id={inputId}
							value={strVal()}
							onInput={(e) => props.onChange(e.currentTarget.value)}
							disabled={props.disabled}
							style={inputStyle}
						/>
					)}
				</label>
			);
		}

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
										color:
											n <= numVal()
												? "var(--seed-warning)"
												: "var(--color-border-light)",
									}}
								>
									★
								</button>
							))}
							<span
								style={{
									"font-size": "12px",
									color: "var(--color-text-muted)",
									"margin-left": "4px",
									"align-self": "center",
								}}
							>
								{numVal() > 0 ? numVal() : ""}
							</span>
						</div>
					</div>
				);
			}

			// duration: stored as raw milliseconds, displayed humanised.
			// Edit mode keeps the plain number input so the AI/system that
			// writes durations can still set them precisely.
			if (display() === "duration") {
				return (
					<label>
						<div style={labelStyle}>{props.attr.name}</div>
						<Show
							when={!props.disabled}
							fallback={
								<div style={{ "font-size": "13px" }}>
									{formatDurationMs(numVal())}
								</div>
							}
						>
							<input
								type="number"
								value={numVal()}
								onInput={(e) => props.onChange(Number(e.currentTarget.value))}
								style={inputStyle}
							/>
						</Show>
					</label>
				);
			}

			// currency: stored as a decimal in the configured ISO 4217
			// currency (USD by default). Display uses Intl.NumberFormat so
			// locale picks the right symbol position automatically.
			if (display() === "currency") {
				const currency = () =>
					typeof props.attr.config.currency === "string"
						? props.attr.config.currency
						: "USD";
				return (
					<label>
						<div style={labelStyle}>{props.attr.name}</div>
						<Show
							when={!props.disabled}
							fallback={
								<div style={{ "font-size": "13px" }}>
									{formatCurrency(numVal(), currency())}
								</div>
							}
						>
							<input
								type="number"
								step="0.0001"
								value={numVal()}
								onInput={(e) => props.onChange(Number(e.currentTarget.value))}
								style={inputStyle}
							/>
						</Show>
					</label>
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

		case "dimension": {
			const dim = () => {
				if (typeof props.value === "object" && props.value !== null) {
					const v = props.value as { width?: number; height?: number };
					return {
						width: typeof v.width === "number" ? v.width : 0,
						height: typeof v.height === "number" ? v.height : 0,
					};
				}
				return { width: 0, height: 0 };
			};
			const inputId = `attr-${props.attr.id}`;
			return (
				<div>
					<div style={labelStyle}>{props.attr.name}</div>
					<Show
						when={!props.disabled}
						fallback={
							<div style={{ "font-size": "13px" }}>
								{dim().width && dim().height
									? `${dim().width} × ${dim().height} px`
									: "(unset)"}
							</div>
						}
					>
						<div
							style={{ display: "flex", "align-items": "center", gap: "6px" }}
						>
							<input
								id={inputId}
								type="number"
								min={1}
								value={dim().width}
								onInput={(e) =>
									props.onChange({
										...dim(),
										width: Number(e.currentTarget.value),
									})
								}
								style={{ ...inputStyle, width: "5em" }}
								aria-label="width"
							/>
							<span style={{ color: "var(--color-text-muted)" }}>×</span>
							<input
								type="number"
								min={1}
								value={dim().height}
								onInput={(e) =>
									props.onChange({
										...dim(),
										height: Number(e.currentTarget.value),
									})
								}
								style={{ ...inputStyle, width: "5em" }}
								aria-label="height"
							/>
							<span
								style={{
									"font-size": "11px",
									color: "var(--color-text-muted)",
								}}
							>
								px
							</span>
						</div>
					</Show>
				</div>
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
						<span
							style={{
								"align-self": "center",
								color: "var(--color-text-muted)",
							}}
						>
							to
						</span>
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
												border:
													"1px solid var(--color-primary-border, #bae6fd)",
												"font-size": "0.7rem",
												color: "var(--color-primary, #3b82f6)",
											}}
										>
											{v}
										</span>
									)}
								</For>
								<Show when={selected().length === 0}>
									<span
										style={{
											"font-size": "0.75rem",
											color: "var(--color-text-muted)",
										}}
									>
										(none)
									</span>
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
												"border-color": isSelected()
													? "var(--color-primary-border, #bae6fd)"
													: "var(--color-border-light, #e5e7eb)",
												background: isSelected()
													? "var(--color-primary-bg, #eff6ff)"
													: "transparent",
												"font-size": "0.7rem",
												color: isSelected()
													? "var(--color-primary, #3b82f6)"
													: "var(--color-text-secondary)",
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
								fallback={
									<span
										style={{
											"font-size": "0.75rem",
											color: "var(--color-text-muted)",
										}}
									>
										(none)
									</span>
								}
							>
								<a
									href={strVal()}
									target="_blank"
									rel="noopener noreferrer"
									style={{
										"font-size": "0.8rem",
										color: "var(--link-color, #0066cc)",
										"word-break": "break-all",
									}}
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
