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
				body: JSON.stringify({ name, kind, config }),
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
				body: JSON.stringify({ name, kind, config, indexed: attr.indexed }),
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
						color: "#b00020",
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
					<div style={{ color: "#999", "font-size": "13px" }}>
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
				border: "1px solid #eee",
				"border-radius": "6px",
				background: props.attr.inherited ? "#f8f8ff" : "#fff",
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
						color: props.onMoveUp ? "#666" : "#ddd",
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
						color: props.onMoveDown ? "#666" : "#ddd",
					}}
					title="Move down"
				>
					&#9660;
				</button>
			</div>
			<span style={{ flex: 1, "font-size": "13px" }}>
				<strong>{props.attr.name}</strong>
				<span style={{ color: "#888", "margin-left": "6px" }}>
					{props.attr.kind}
				</span>
				<Show when={props.attr.inherited}>
					<span
						style={{
							color: "#aaa",
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

	const buildConfig = (): Record<string, unknown> => {
		const c: Record<string, unknown> = {};
		if (kind() === "select") {
			c.options = options()
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		if (display()) c.display = display();
		return c;
	};

	return (
		<div
			style={{
				display: "grid",
				gap: "6px",
				padding: "8px",
				border: "1px solid #ccc",
				"border-radius": "6px",
				background: "#fafafa",
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

			<Show when={kind() === "file"}>
				<select
					value={display()}
					onChange={(e) => setDisplay(e.currentTarget.value)}
					style={{ padding: "4px 6px" }}
				>
					<option value="">Default (download)</option>
					<option value="preview">Preview</option>
					<option value="player">Player</option>
					<option value="download">Download</option>
				</select>
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
