import { useNavigate } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../auth/keycloak";
import { Button } from "../../components/Button";
import type { NookStore } from "./store";

type DiffResult = {
	content_diff: string;
	hunks: Array<{
		old_start: number;
		old_count: number;
		new_start: number;
		new_count: number;
		lines: Array<{ type: string; content: string }>;
	}>;
	stats: { additions: number; deletions: number; unchanged: number };
	from: { version: number; title: string; type_id: string; attributes: Record<string, unknown> };
	to: { version: number; title: string; type_id: string; attributes: Record<string, unknown> };
};

type Props = {
	store: NookStore;
	fromVersion: number;
	toVersion?: number;
};

export function NookComparePage(props: Props) {
	const navigate = useNavigate();
	const nookId = () => props.store.nookId();
	const noteId = () => props.store.selectedId();

	const fetchDiff = async (): Promise<DiffResult | null> => {
		const nook = nookId();
		const note = noteId();
		if (!nook || !note) return null;
		const params = new URLSearchParams();
		params.set("from", String(props.fromVersion));
		if (props.toVersion) params.set("to", String(props.toVersion));
		const res = await apiFetch(
			`/api/nooks/${nook}/notes/${note}/diff?${params}`,
		);
		if (!res.ok) return null;
		return (await res.json()) as DiffResult;
	};

	const [diff] = createResource(
		() => `${nookId()}|${noteId()}|${props.fromVersion}|${props.toVersion ?? "current"}`,
		fetchDiff,
	);

	const goBack = () => {
		const nook = nookId();
		const note = noteId();
		if (nook && note) {
			navigate(
				`/nooks/${encodeURIComponent(nook)}/notes/${encodeURIComponent(note)}/v/${props.fromVersion}`,
			);
		}
	};

	return (
		<div style={{ padding: "1.5rem", "max-width": "800px" }}>
			<div
				style={{
					display: "flex",
					"align-items": "center",
					"justify-content": "space-between",
					"margin-bottom": "1rem",
				}}
			>
				<h3 style={{ margin: "0", "font-size": "1.1rem" }}>
					Compare versions
				</h3>
				<Button variant="secondary" size="small" onClick={goBack}>
					Back
				</Button>
			</div>

			<Show when={diff.loading}>
				<div style={{ color: "var(--color-text-muted)", "font-size": "0.85rem" }}>
					Loading diff...
				</div>
			</Show>

			<Show when={diff()}>
				{(d) => (
					<>
						{/* Header */}
						<div
							style={{
								display: "flex",
								gap: "16px",
								"align-items": "center",
								"margin-bottom": "12px",
								"font-size": "0.85rem",
							}}
						>
							<div>
								<span style={{ "font-weight": "600" }}>v{d().from.version}</span>
								<Show when={d().from.title !== d().to.title}>
									<span style={{ color: "var(--color-text-muted)", "margin-left": "6px" }}>
										{d().from.title}
									</span>
								</Show>
							</div>
							<span style={{ color: "var(--color-text-muted)" }}>→</span>
							<div>
								<span style={{ "font-weight": "600" }}>
									v{d().to.version}
									{!props.toVersion ? " (current)" : ""}
								</span>
								<Show when={d().from.title !== d().to.title}>
									<span style={{ color: "var(--color-text-muted)", "margin-left": "6px" }}>
										{d().to.title}
									</span>
								</Show>
							</div>
						</div>

						{/* Stats */}
						<div
							style={{
								display: "flex",
								gap: "16px",
								"margin-bottom": "16px",
								"font-size": "0.8rem",
							}}
						>
							<span style={{ color: "var(--color-success, #22c55e)" }}>
								+{d().stats.additions} added
							</span>
							<span style={{ color: "var(--color-danger, #ef4444)" }}>
								-{d().stats.deletions} removed
							</span>
							<span style={{ color: "var(--color-text-muted)" }}>
								{d().stats.unchanged} unchanged
							</span>
						</div>

						{/* Title change */}
						<Show when={d().from.title !== d().to.title}>
							<div
								style={{
									padding: "8px 12px",
									"margin-bottom": "12px",
									"border-radius": "6px",
									border: "1px solid var(--color-border-light)",
									"font-size": "0.8rem",
								}}
							>
								<span style={{ color: "var(--color-text-muted)" }}>Title: </span>
								<span style={{ "text-decoration": "line-through", color: "var(--color-danger)" }}>
									{d().from.title}
								</span>
								{" → "}
								<span style={{ color: "var(--color-success)" }}>{d().to.title}</span>
							</div>
						</Show>

						{/* Diff */}
						<Show
							when={d().content_diff}
							fallback={
								<div style={{ color: "var(--color-text-muted)", "font-size": "0.85rem" }}>
									No content changes between these versions.
								</div>
							}
						>
							<pre
								style={{
									"font-family": "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
									"font-size": "0.8rem",
									"line-height": "1.6",
									overflow: "auto",
									padding: "12px",
									background: "var(--color-bg-secondary, #f9fafb)",
									border: "1px solid var(--color-border-light, #e5e7eb)",
									"border-radius": "6px",
									"white-space": "pre-wrap",
									"word-break": "break-word",
									margin: "0",
								}}
							>
								<For each={d().content_diff.split("\n")}>
									{(line) => {
										const color = line.startsWith("+")
											? "var(--color-success, #22c55e)"
											: line.startsWith("-")
												? "var(--color-danger, #ef4444)"
												: line.startsWith("@@")
													? "var(--color-primary, #3b82f6)"
													: "inherit";
										const bg = line.startsWith("+")
											? "rgba(34,197,94,0.08)"
											: line.startsWith("-")
												? "rgba(239,68,68,0.08)"
												: "transparent";
										return (
											<div
												style={{
													color,
													background: bg,
													padding: "0 4px",
													margin: "0 -4px",
												}}
											>
												{line || " "}
											</div>
										);
									}}
								</For>
							</pre>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}
