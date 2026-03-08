import { useNavigate } from "@solidjs/router";
import { createSignal, For, Show } from "solid-js";
import { Button } from "../../components/Button";
import { NookTypeEditPanel } from "./NookTypeEditPanel";
import type { NookStore } from "./store";

export type NookTypesSettingsViewProps = {
	nookId: string;
	store: NookStore;
	typeEditId: string;
	onClose: () => void;
};

export function NookTypesSettingsView(props: NookTypesSettingsViewProps) {
	const navigate = useNavigate();
	const [typesExpanded, setTypesExpanded] = createSignal<Record<string, boolean>>({});

	const toggleTypesExpanded = (id: string) => {
		const tid = id.trim();
		if (tid === "") return;
		setTypesExpanded((e) => ({ ...e, [tid]: !(e[tid] ?? true) }));
	};

	const childrenOfType = (parentId: string) =>
		props.store
			.noteTypes()
			.filter((t) => String(t.parentId ?? "").trim() === parentId.trim());

	const rootTypes = () => childrenOfType("");

	const onAddType = async () => {
		const label = window.prompt("Type label");
		if (!label) return;
		const keyDefault = label
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const key = window.prompt("Type key (unique)", keyDefault);
		if (!key) return;
		const created = await props.store.createNoteType({ key, label, parentId: "" });
		if (!created) return;
		navigate(
			`/nooks/${encodeURIComponent(props.nookId)}/settings/types/${encodeURIComponent(created.id)}/edit`,
		);
	};

	const onAddSubtype = async () => {
		const parentId = props.typeEditId.trim();
		if (parentId === "") return;
		const parent = props.store.noteTypes().find((t) => t.id === parentId) ?? null;
		const label = window.prompt(`Subtype label${parent ? ` (under ${parent.label})` : ""}`);
		if (!label) return;
		const keyDefault = label
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		const key = window.prompt("Type key (unique)", keyDefault);
		if (!key) return;
		const created = await props.store.createNoteType({ key, label, parentId });
		if (!created) return;
		navigate(
			`/nooks/${encodeURIComponent(props.nookId)}/settings/types/${encodeURIComponent(created.id)}/edit`,
		);
	};

	const onDeleteType = async () => {
		const tid = props.typeEditId.trim();
		if (tid === "") return;
		const t = props.store.noteTypes().find((x) => x.id === tid) ?? null;
		if (!t) return;
		if (!window.confirm(`Delete type \"${t.label}\"?`)) return;
		await props.store.deleteNoteType(t);
		navigate(`/nooks/${encodeURIComponent(props.nookId)}/settings/types`);
	};

	const renderTypeTreeNode = (t: { id: string; label: string; parentId: string }, depth: number) => {
		const children = childrenOfType(t.id);
		const isOpen = typesExpanded()[t.id] ?? true;
		return (
			<div>
				<div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
					<Button
						variant={t.id === props.typeEditId ? "primary" : "secondary"}
						size="small"
						onClick={() => {
							navigate(
								`/nooks/${encodeURIComponent(props.nookId)}/settings/types/${encodeURIComponent(t.id)}/edit`,
							);
						}}
						style={{
							width: "100%",
							"text-align": "left",
							"margin-left": `${depth * 12}px`,
						}}
					>
						{children.length > 0 ? (isOpen ? "▾ " : "▸ ") : ""}
						{t.label}
					</Button>
					<Show when={children.length > 0}>
						<button
							type="button"
							onClick={() => toggleTypesExpanded(t.id)}
							style={{
								border: "1px solid #ddd",
								"border-radius": "6px",
								padding: "0 6px",
								background: "white",
								cursor: "pointer",
							}}
							title={isOpen ? "Collapse" : "Expand"}
						>
							{isOpen ? "–" : "+"}
						</button>
					</Show>
				</div>
				<Show when={children.length > 0 && isOpen}>
					<For each={children}>{(c) => renderTypeTreeNode(c, depth + 1)}</For>
				</Show>
			</div>
		);
	};

	return (
		<div style={{ width: "100%" }}>
			<div
				style={{
					display: "flex",
					"justify-content": "space-between",
					"margin-bottom": "12px",
				}}
			>
				<div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
					<Button variant="secondary" size="small" onClick={() => void onAddType()}>
						Add type
					</Button>
					<Button
						variant="secondary"
						size="small"
						onClick={() => void onAddSubtype()}
						disabled={props.typeEditId.trim() === ""}
						title={
							props.typeEditId.trim() === ""
								? "Select a parent type first"
								: "Create subtype under selected type"
						}
					>
						Add subtype
					</Button>
					<Button
						variant="danger"
						size="small"
						onClick={() => void onDeleteType()}
						disabled={props.typeEditId.trim() === ""}
						title={props.typeEditId.trim() === "" ? "Select a type first" : "Delete selected type"}
					>
						Delete
					</Button>
				</div>
				<div />
			</div>

			<div style={{ display: "flex", gap: "12px" }}>
				<div style={{ width: "260px", "flex-shrink": "0" }}>
					<div style={{ "font-weight": 600, "margin-bottom": "8px" }}>Types</div>
					<div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
						<For each={rootTypes()}>{(t) => renderTypeTreeNode(t, 0)}</For>
					</div>
				</div>

				<div style={{ flex: "1", "min-width": "0" }}>
					<Show
						when={props.typeEditId.trim() !== ""}
						fallback={<div style={{ padding: "12px" }}>Select a type to edit.</div>}
					>
						<NookTypeEditPanel store={props.store} typeId={props.typeEditId} />
					</Show>
				</div>
			</div>
		</div>
	);
}
