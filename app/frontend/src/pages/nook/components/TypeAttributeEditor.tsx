import { createResource, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { Button } from "../../../components/Button";
import type { NookStore } from "../store";
import {
	type TypeAttribute,
	type TypeAttributeKind,
	TypeAttributeKinds,
	TypeAttributeResponseSchema,
	TypeAttributesListResponseSchema,
} from "../types";

export type TypeAttributeEditorProps = {
	nookId: string;
	typeId: string;
	store: NookStore;
};

export function TypeAttributeEditor(props: TypeAttributeEditorProps) {
	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [error, setError] = createSignal("");

	const fetchAttributes = async () => {
		if (!props.nookId || !props.typeId) return [];
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes`,
		);
		if (!res.ok) return [];
		const json = await res.json();
		return TypeAttributesListResponseSchema.parse(json).attributes;
	};

	const [attributes, { refetch }] = createResource(
		() => `${props.nookId}|${props.typeId}`,
		fetchAttributes,
	);

	const [adding, setAdding] = createSignal(false);

	const indexableKinds = new Set(["text", "number", "date", "date_range", "select"]);

	const onAddSave = async (
		name: string,
		kind: TypeAttributeKind,
		config: Record<string, unknown>,
	) => {
		setError("");
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, kind, config, indexed: indexableKinds.has(kind) }),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
		setAdding(false);
		void refetch();
	};

	const onDelete = async (attr: TypeAttribute) => {
		if (!window.confirm(`Delete attribute "${attr.name}"?`)) return;
		setError("");
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes/${attr.id}`,
			{ method: "DELETE" },
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
		void refetch();
	};

	const onMove = async (attrId: string, direction: "up" | "down") => {
		const list = attributes();
		if (!list) return;
		const ids = list.map((a) => a.id);
		const idx = ids.indexOf(attrId);
		if (idx < 0) return;
		const swapIdx = direction === "up" ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= ids.length) return;
		[ids[idx], ids[swapIdx]] = [ids[swapIdx], ids[idx]];

		const type = props.store
			.noteTypes()
			.find((t) => t.id === props.typeId);
		if (!type) return;

		setError("");
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: type.key,
					label: type.label,
					description: type.description,
					parent_id: type.parentId,
					attribute_order: ids,
				}),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
		void refetch();
	};

	const onSaveEdit = async (
		attr: TypeAttribute,
		name: string,
		kind: TypeAttributeKind,
		config: Record<string, unknown>,
	) => {
		setError("");
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes/${attr.id}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, kind, config, indexed: indexableKinds.has(kind) }),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
		setEditingId(null);
		void refetch();
	};

	return (
		<div style={{ "margin-top": "16px" }}>
			<div
				style={{
					display: "flex",
					"align-items": "center",
					gap: "8px",
					"margin-bottom": "8px",
				}}
			>
				<h3 style={{ margin: 0 }}>Attributes</h3>
				<Show when={!adding()}>
					<Button size="small" onClick={() => setAdding(true)}>
						+ Add
					</Button>
				</Show>
			</div>

			<Show when={adding()}>
				<AttributeEditRow
					attr={{
						id: "",
						typeId: props.typeId,
						name: "",
						kind: "text",
						config: {},
						indexed: false,
						inherited: false,
						createdAt: undefined,
						updatedAt: undefined,
					}}
					onSave={(name, kind, config) => void onAddSave(name, kind, config)}
					onCancel={() => setAdding(false)}
				/>
			</Show>

			<Show when={error() !== ""}>
				<pre
					style={{
						margin: "0 0 8px",
						color: "var(--color-danger)",
						"white-space": "pre-wrap",
						"font-size": "12px",
					}}
				>
					{error()}
				</pre>
			</Show>

			<Show
				when={attributes() && attributes()!.length > 0}
				fallback={
					<div style={{ color: "var(--color-text-muted)", "font-size": "13px" }}>
						No attributes defined.
					</div>
				}
			>
				<div style={{ display: "grid", gap: "6px" }}>
					<For each={attributes()}>
						{(attr, index) => (
							<Show
								when={editingId() === attr.id}
								fallback={
									<AttributeRow
										attr={attr}
										onEdit={() => setEditingId(attr.id)}
										onDelete={() => void onDelete(attr)}
										onMoveUp={index() > 0 ? () => void onMove(attr.id, "up") : undefined}
										onMoveDown={index() < (attributes()?.length ?? 0) - 1 ? () => void onMove(attr.id, "down") : undefined}
									/>
								}
							>
								<AttributeEditRow
									attr={attr}
									onSave={(name, kind, config) =>
										void onSaveEdit(attr, name, kind, config)
									}
									onCancel={() => setEditingId(null)}
								/>
							</Show>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

function AttributeRow(props: {
	attr: TypeAttribute;
	onEdit: () => void;
	onDelete: () => void;
	onMoveUp?: () => void;
	onMoveDown?: () => void;
}) {
	return (
		<div
			style={{
				display: "flex",
				"align-items": "center",
				gap: "4px",
				padding: "6px 8px",
				border: "1px solid var(--color-border-light)",
				"border-radius": "6px",
				background: props.attr.inherited ? "var(--color-bg-secondary)" : "var(--color-bg)",
			}}
		>
			<div
				style={{
					display: "flex",
					"flex-direction": "column",
					gap: "1px",
					"margin-right": "4px",
				}}
			>
				<button
					type="button"
					disabled={!props.onMoveUp}
					onClick={() => props.onMoveUp?.()}
					style={{
						border: "none",
						background: "none",
						cursor: props.onMoveUp ? "pointer" : "default",
						padding: "0",
						"font-size": "10px",
						"line-height": "1",
						color: props.onMoveUp ? "var(--color-text-secondary)" : "var(--color-border-light)",
					}}
					title="Move up"
				>
					&#9650;
				</button>
				<button
					type="button"
					disabled={!props.onMoveDown}
					onClick={() => props.onMoveDown?.()}
					style={{
						border: "none",
						background: "none",
						cursor: props.onMoveDown ? "pointer" : "default",
						padding: "0",
						"font-size": "10px",
						"line-height": "1",
						color: props.onMoveDown ? "var(--color-text-secondary)" : "var(--color-border-light)",
					}}
					title="Move down"
				>
					&#9660;
				</button>
			</div>
			<span style={{ flex: 1, "font-size": "13px" }}>
				<strong>{props.attr.name}</strong>
				<span style={{ color: "var(--color-text-muted)", "margin-left": "6px" }}>
					{props.attr.kind}
					{props.attr.config.display ? ` · ${props.attr.config.display}` : ""}
				</span>
				<Show when={props.attr.inherited}>
					<span
						style={{
							color: "var(--color-text-faint)",
							"margin-left": "6px",
							"font-size": "11px",
						}}
					>
						(inherited)
					</span>
				</Show>
			</span>
			<Show when={!props.attr.inherited}>
				<Button size="small" variant="secondary" onClick={props.onEdit}>
					Edit
				</Button>
				<Button size="small" variant="secondary" onClick={props.onDelete}>
					Del
				</Button>
			</Show>
		</div>
	);
}

function AttributeEditRow(props: {
	attr: TypeAttribute;
	onSave: (
		name: string,
		kind: TypeAttributeKind,
		config: Record<string, unknown>,
	) => void;
	onCancel: () => void;
}) {
	const [name, setName] = createSignal(props.attr.name);
	const [kind, setKind] = createSignal<TypeAttributeKind>(props.attr.kind);
	const [options, setOptions] = createSignal(
		Array.isArray(props.attr.config.options)
			? (props.attr.config.options as string[]).join(", ")
			: "",
	);
	const [display, setDisplay] = createSignal(
		(props.attr.config.display as string) ?? "",
	);
	const [max, setMax] = createSignal(
		String(props.attr.config.max ?? ""),
	);
	const [lnDirection, setLnDirection] = createSignal(
		String(props.attr.config.direction ?? "both"),
	);
	const [lnIncludeMentions, setLnIncludeMentions] = createSignal(
		props.attr.config.include_mentions !== false,
	);
	const [historyLimit, setHistoryLimit] = createSignal(
		String(props.attr.config.limit ?? "5"),
	);

	const buildConfig = (): Record<string, unknown> => {
		const c: Record<string, unknown> = {};
		if (kind() === "select") {
			c.options = options()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		if (display()) c.display = display();
		if (kind() === "number" && max()) c.max = Number(max());
		if (kind() === "linked_notes") {
			c.direction = lnDirection();
			c.include_mentions = lnIncludeMentions();
			if (display()) c.display = display();
		}
		if (kind() === "history") {
			c.limit = Number(historyLimit()) || 5;
		}
		return c;
	};

	return (
		<div
			style={{
				display: "grid",
				gap: "6px",
				padding: "8px",
				border: "1px solid var(--color-border-medium)",
				"border-radius": "6px",
				background: "var(--color-bg-secondary)",
			}}
		>
			<div style={{ display: "flex", gap: "6px" }}>
				<input
					value={name()}
					onInput={(e) => setName(e.currentTarget.value)}
					placeholder="Name"
					style={{ flex: 1, padding: "4px 6px" }}
				/>
				<select
					value={kind()}
					onChange={(e) => setKind(e.currentTarget.value as TypeAttributeKind)}
					style={{ padding: "4px 6px" }}
				>
					<For each={[...TypeAttributeKinds]}>
						{(k) => <option value={k}>{k}</option>}
					</For>
				</select>
			</div>

			<Show when={kind() === "select"}>
				<input
					value={options()}
					onInput={(e) => setOptions(e.currentTarget.value)}
					placeholder="Options (comma-separated)"
					style={{ padding: "4px 6px" }}
				/>
			</Show>

			<Show when={kind() === "text"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={{ padding: "4px 6px" }}
				>
					<option value="">Single line (default)</option>
					<option value="paragraph">Paragraph</option>
				</select>
			</Show>

			<Show when={kind() === "number"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<select
						value={display()}
						onChange={(e) => setDisplay(e.currentTarget.value)}
						style={{ padding: "4px 6px" }}
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
							style={{ width: "80px", padding: "4px 6px" }}
						/>
					</Show>
				</div>
			</Show>

			<Show when={kind() === "file"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={{ padding: "4px 6px" }}
				>
					<option value="">Download (default)</option>
					<option value="preview">Preview</option>
					<option value="player">Player</option>
				</select>
			</Show>

			<Show when={kind() === "linked_notes"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<select
						value={lnDirection()}
						onChange={(e) => setLnDirection(e.currentTarget.value)}
						style={{ padding: "4px 6px", "font-size": "12px" }}
					>
						<option value="outgoing">Outgoing (references from this note)</option>
						<option value="incoming">Incoming (references to this note)</option>
						<option value="both">Both directions</option>
					</select>
					<label style={{ display: "flex", "align-items": "center", gap: "4px", "font-size": "12px" }}>
						<input
							type="checkbox"
							checked={lnIncludeMentions()}
							onChange={(e) => setLnIncludeMentions(e.currentTarget.checked)}
						/>
						Include mentions
					</label>
				</div>
			</Show>

			<Show when={kind() === "history"}>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<label style={{ "font-size": "12px" }}>Show last</label>
					<input
						type="number"
						value={historyLimit()}
						onInput={(e) => setHistoryLimit(e.currentTarget.value)}
						min="1"
						max="50"
						style={{ width: "60px", padding: "4px 6px", "font-size": "12px" }}
					/>
					<span style={{ "font-size": "12px" }}>entries</span>
				</div>
			</Show>

			<div style={{ display: "flex", gap: "6px" }}>
				<Button
					size="small"
					onClick={() => props.onSave(name(), kind(), buildConfig())}
				>
					Save
				</Button>
				<Button size="small" variant="secondary" onClick={props.onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
