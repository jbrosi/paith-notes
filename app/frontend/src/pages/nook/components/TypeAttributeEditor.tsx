import { createSignal, createResource, For, Show } from "solid-js";
import { Button } from "../../../components/Button";
import { apiFetch } from "../../../auth/keycloak";
import {
	TypeAttributeKinds,
	TypeAttributesListResponseSchema,
	TypeAttributeResponseSchema,
	type TypeAttribute,
	type TypeAttributeKind,
} from "../types";

export type TypeAttributeEditorProps = {
	nookId: string;
	typeId: string;
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

	const onAdd = async () => {
		const name = window.prompt("Attribute name");
		if (!name?.trim()) return;
		setError("");
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: name.trim(), kind: "text" }),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
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
				<Button size="small" onClick={onAdd}>
					+ Add
				</Button>
			</div>

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
						{(attr) => (
							<Show
								when={editingId() === attr.id}
								fallback={
									<AttributeRow
										attr={attr}
										onEdit={() => setEditingId(attr.id)}
										onDelete={() => void onDelete(attr)}
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
}) {
	return (
		<div
			style={{
				display: "flex",
				"align-items": "center",
				gap: "8px",
				padding: "6px 8px",
				border: "1px solid #eee",
				"border-radius": "6px",
				background: props.attr.inherited ? "#f8f8ff" : "#fff",
			}}
		>
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
					onChange={(e) =>
						setKind(e.currentTarget.value as TypeAttributeKind)
					}
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
