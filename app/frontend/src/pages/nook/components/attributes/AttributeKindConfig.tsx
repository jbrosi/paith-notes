import { createSignal, Show } from "solid-js";
import type { TypeAttributeKind } from "../../types";

export type KindConfigState = {
	buildConfig: () => Record<string, unknown>;
};

/**
 * Renders kind-specific config UI and exposes buildConfig().
 * The parent passes the initial config and reads buildConfig() on save.
 */
export function AttributeKindConfig(props: {
	kind: TypeAttributeKind;
	config: Record<string, unknown>;
	ref: (state: KindConfigState) => void;
}) {
	// ── Shared state ────────────────────────────────────────────────────
	const [display, setDisplay] = createSignal(
		(props.config.display as string) ?? "",
	);
	const [options, setOptions] = createSignal(
		Array.isArray(props.config.options)
			? (props.config.options as string[]).join(", ")
			: "",
	);
	const [max, setMax] = createSignal(String(props.config.max ?? ""));

	// ── Linked notes / mentions ──────────────────────────────────────────
	const [lnDirection, setLnDirection] = createSignal(
		String(props.config.direction ?? "both"),
	);

	// ── History ─────────────────────────────────────────────────────────
	const [historyLimit, setHistoryLimit] = createSignal(
		String(props.config.limit ?? "5"),
	);

	// ── TOC ─────────────────────────────────────────────────────────────
	const [tocMaxDepth, setTocMaxDepth] = createSignal(
		String(props.config.max_depth ?? "3"),
	);

	// ── Content ─────────────────────────────────────────────────────────
	const [contentMode, setContentMode] = createSignal(
		String(props.config.mode ?? "markdown"),
	);

	// ── Metadata ────────────────────────────────────────────────────────
	const [mdShowVersion, setMdShowVersion] = createSignal(
		props.config.show_version !== false,
	);
	const [mdShowCreated, setMdShowCreated] = createSignal(
		props.config.show_created !== false,
	);
	const [mdShowUpdated, setMdShowUpdated] = createSignal(
		props.config.show_updated !== false,
	);
	const [mdShowViews, setMdShowViews] = createSignal(
		props.config.show_views !== false,
	);

	// ── Build config ────────────────────────────────────────────────────
	const buildConfig = (): Record<string, unknown> => {
		const c: Record<string, unknown> = {};
		const k = props.kind;
		if (k === "select" || k === "multi_select") {
			c.options = options()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		if (display()) c.display = display();
		if (k === "number" && max()) c.max = Number(max());
		if (k === "linked_notes" || k === "mentions") {
			c.direction = lnDirection();
		}
		if (k === "history") c.limit = Number(historyLimit()) || 5;
		if (k === "toc") c.max_depth = Number(tocMaxDepth()) || 3;
		if (k === "content") c.mode = contentMode();
		if (k === "metadata") {
			c.show_version = mdShowVersion();
			c.show_created = mdShowCreated();
			c.show_updated = mdShowUpdated();
			c.show_views = mdShowViews();
		}
		return c;
	};

	// Expose buildConfig to parent
	props.ref({ buildConfig });

	const s = { padding: "4px 6px", "font-size": "12px" } as const;

	return (
		<>
			<Show when={props.kind === "select" || props.kind === "multi_select"}>
				<input
					value={options()}
					onInput={(e) => setOptions(e.currentTarget.value)}
					placeholder="Options (comma-separated)"
					style={{ padding: "4px 6px" }}
				/>
			</Show>

			<Show when={props.kind === "text"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={s}
				>
					<option value="">Single line (default)</option>
					<option value="paragraph">Paragraph</option>
				</select>
			</Show>

			<Show when={props.kind === "number"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<select
						value={display()}
						onChange={(e) => setDisplay(e.currentTarget.value)}
						style={s}
					>
						<option value="">Plain number (default)</option>
						<option value="rating">Rating</option>
					</select>
					<Show when={display() === "rating"}>
						<input
							type="number"
							value={max()}
							onInput={(e) => setMax(e.currentTarget.value)}
							placeholder="Max (e.g. 5)"
							style={{ width: "80px", ...s }}
						/>
					</Show>
				</div>
			</Show>

			<Show when={props.kind === "file"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={s}
				>
					<option value="">Download (default)</option>
					<option value="preview">Preview</option>
					<option value="player">Player</option>
				</select>
			</Show>

			<Show when={props.kind === "content"}>
				<select
					value={contentMode()}
					onChange={(e) => setContentMode(e.currentTarget.value)}
					style={s}
				>
					<option value="markdown">Markdown (default)</option>
					<option value="plain">Plain text</option>
					<option value="code">Code</option>
					<option value="hidden">Hidden (no content body)</option>
				</select>
			</Show>

			<Show when={props.kind === "linked_notes" || props.kind === "mentions"}>
				<select
					value={lnDirection()}
					onChange={(e) => setLnDirection(e.currentTarget.value)}
					style={s}
				>
					<option value="outgoing">Outgoing (from this note)</option>
					<option value="incoming">Incoming (to this note)</option>
					<option value="both">Both directions</option>
				</select>
			</Show>

			<Show when={props.kind === "history"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<label for="attr-history-limit" style={{ "font-size": "12px" }}>
						Show last
					</label>
					<input
						id="attr-history-limit"
						type="number"
						value={historyLimit()}
						onInput={(e) => setHistoryLimit(e.currentTarget.value)}
						min="0"
						max="50"
						style={{ width: "60px", ...s }}
					/>
					<span style={{ "font-size": "12px" }}>
						entries (0 = version info only)
					</span>
				</div>
			</Show>

			<Show when={props.kind === "metadata"}>
				<div
					style={{
						display: "flex",
						gap: "8px",
						"flex-wrap": "wrap",
						"font-size": "12px",
					}}
				>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowVersion()}
							onChange={(e) => setMdShowVersion(e.currentTarget.checked)}
						/>{" "}
						Version
					</label>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowCreated()}
							onChange={(e) => setMdShowCreated(e.currentTarget.checked)}
						/>{" "}
						Created
					</label>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowUpdated()}
							onChange={(e) => setMdShowUpdated(e.currentTarget.checked)}
						/>{" "}
						Last edited
					</label>
					<label
						style={{ display: "flex", "align-items": "center", gap: "3px" }}
					>
						<input
							type="checkbox"
							checked={mdShowViews()}
							onChange={(e) => setMdShowViews(e.currentTarget.checked)}
						/>{" "}
						View count
					</label>
				</div>
			</Show>

			<Show when={props.kind === "toc"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<label for="attr-toc-max-depth" style={{ "font-size": "12px" }}>
						Max heading depth
					</label>
					<select
						id="attr-toc-max-depth"
						value={tocMaxDepth()}
						onChange={(e) => setTocMaxDepth(e.currentTarget.value)}
						style={s}
					>
						<option value="1">h1 only</option>
						<option value="2">h1–h2</option>
						<option value="3">h1–h3</option>
						<option value="4">h1–h4</option>
						<option value="5">h1–h5</option>
						<option value="6">All levels</option>
					</select>
					<span
						style={{ "font-size": "11px", color: "var(--color-text-muted)" }}
					>
						(can be overridden per note)
					</span>
				</div>
			</Show>
		</>
	);
}
