import { createResource, createSignal, For, Show } from "solid-js";
import { apiFetch } from "../../../auth/keycloak";
import { Button } from "../../../components/Button";
import { validateAttributeConfig } from "../attributeValidation";
import type { NookStore } from "../store";
import {
	type NoteType,
	type Panel,
	type PanelPosition,
	PanelPositions,
	type TypeAttribute,
	type TypeAttributeKind,
	TypeAttributeKinds,
	TypeAttributesListResponseSchema,
} from "../types";
import {
	AttributeKindConfig,
	type KindConfigState,
} from "./attributes/AttributeKindConfig";

export type TypeAttributeEditorProps = {
	nookId: string;
	typeId: string;
	store: NookStore;
};

export function TypeAttributeEditor(props: TypeAttributeEditorProps) {
	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [error, setError] = createSignal("");
	const [addingPanel, setAddingPanel] = createSignal(false);
	const [editingPanelKey, setEditingPanelKey] = createSignal<string | null>(
		null,
	);

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

	const indexableKinds = new Set([
		"text",
		"number",
		"date",
		"date_range",
		"select",
		"dimension",
	]);

	const getType = (): NoteType | undefined =>
		props.store.noteTypes().find((t) => t.id === props.typeId);

	const getResolvedPanels = (): Panel[] => {
		return props.store.resolveTypeLayout(props.typeId);
	};

	/** Build current layout with unassigned attributes appended to main panel. */
	const getCurrentLayout = (): { panels: Panel[] } => {
		const panels = getResolvedPanels().map((p) => ({
			...p,
			attributes: [...p.attributes],
		}));
		if (panels.length === 0) {
			panels.push({ key: "main", position: "main", attributes: [] });
		}

		// Append unassigned attributes to main panel
		const list = attributes() ?? [];
		const assigned = new Set(panels.flatMap((p) => p.attributes));
		const mainPanel = panels.find((p) => p.position === "main");
		if (mainPanel) {
			for (const attr of list) {
				if (!assigned.has(attr.id)) {
					mainPanel.attributes.push(attr.id);
				}
			}
		}

		return { panels };
	};

	const saveLayout = async (layout: {
		panels: Array<{
			key: string;
			position: string;
			label?: string;
			collapsible?: boolean;
			order?: number;
			attributes: string[];
		}>;
	}) => {
		const type = getType();
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
					attribute_layout: layout,
				}),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
		void props.store.loadNoteTypes();
		void refetch();
	};

	/** Group attributes by panel. Unassigned attributes go to main. */
	const attributesByPanel = (): Map<string, TypeAttribute[]> => {
		const list = attributes() ?? [];
		const panels = getResolvedPanels();
		const attrMap = new Map(list.map((a) => [a.id, a]));
		const result = new Map<string, TypeAttribute[]>();
		const assigned = new Set<string>();

		for (const panel of panels) {
			const panelAttrs: TypeAttribute[] = [];
			for (const attrId of panel.attributes) {
				const attr = attrMap.get(attrId);
				if (attr) {
					panelAttrs.push(attr);
					assigned.add(attrId);
				}
			}
			result.set(panel.key, panelAttrs);
		}

		// Unassigned attributes go to main panel
		const mainKey = panels.find((p) => p.position === "main")?.key ?? "main";
		const mainAttrs = result.get(mainKey) ?? [];
		for (const attr of list) {
			if (!assigned.has(attr.id)) {
				mainAttrs.push(attr);
			}
		}
		result.set(mainKey, mainAttrs);

		return result;
	};

	const onAddSave = async (
		name: string,
		kind: TypeAttributeKind,
		config: Record<string, unknown>,
		key?: string,
	) => {
		setError("");
		const configErr = validateAttributeConfig(kind, config);
		if (configErr) {
			setError(configErr);
			return;
		}
		const body: Record<string, unknown> = {
			name,
			kind,
			config,
			indexed: indexableKinds.has(kind),
		};
		if (key) body.key = key;
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
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

	const onMoveWithinPanel = async (
		panelKey: string,
		attrId: string,
		direction: "up" | "down",
	) => {
		const layout = getCurrentLayout();
		const panel = layout.panels.find((p) => p.key === panelKey);
		if (!panel) return;

		const idx = panel.attributes.indexOf(attrId);
		if (idx < 0) return;
		const swapIdx = direction === "up" ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= panel.attributes.length) return;

		const newAttrs = [...panel.attributes];
		[newAttrs[idx], newAttrs[swapIdx]] = [newAttrs[swapIdx], newAttrs[idx]];
		panel.attributes = newAttrs;

		await saveLayout(layout);
	};

	const onMoveToPanel = async (
		attrId: string,
		fromPanelKey: string,
		toPanelKey: string,
	) => {
		const layout = getCurrentLayout();
		const fromPanel = layout.panels.find((p) => p.key === fromPanelKey);
		const toPanel = layout.panels.find((p) => p.key === toPanelKey);
		if (!fromPanel || !toPanel) return;

		fromPanel.attributes = fromPanel.attributes.filter((id) => id !== attrId);
		toPanel.attributes = [...toPanel.attributes, attrId];

		await saveLayout(layout);
	};

	/**
	 * Drag-and-drop reorder/move: removes attrId from its current panel and
	 * inserts it into targetPanelKey either before `beforeAttrId` (when
	 * dropped on a specific row) or at the end (when dropped on empty space
	 * in a panel). By-id rather than by-index — no off-by-one when the
	 * source and target panel are the same.
	 */
	const onDropAttribute = async (
		attrId: string,
		targetPanelKey: string,
		beforeAttrId: string | null,
	) => {
		if (attrId === beforeAttrId) return;
		const layout = getCurrentLayout();
		// Locate source by scanning all panels — the dragging row may not know
		// its own panel after a quick re-render.
		const sourcePanel = layout.panels.find((p) =>
			p.attributes.includes(attrId),
		);
		const targetPanel = layout.panels.find((p) => p.key === targetPanelKey);
		if (!sourcePanel || !targetPanel) return;

		sourcePanel.attributes = sourcePanel.attributes.filter(
			(id) => id !== attrId,
		);
		if (beforeAttrId === null) {
			targetPanel.attributes.push(attrId);
		} else {
			const idx = targetPanel.attributes.indexOf(beforeAttrId);
			if (idx >= 0) targetPanel.attributes.splice(idx, 0, attrId);
			else targetPanel.attributes.push(attrId);
		}

		await saveLayout(layout);
	};

	// Track the currently-dragged attribute so AttributeRow can highlight
	// itself as a drop target and so we know what to move on drop.
	const [draggingAttrId, setDraggingAttrId] = createSignal<string | null>(null);
	const [dropTargetAttrId, setDropTargetAttrId] = createSignal<string | null>(
		null,
	);
	const [dropTargetPanelKey, setDropTargetPanelKey] = createSignal<
		string | null
	>(null);

	const onSaveEdit = async (
		attr: TypeAttribute,
		name: string,
		kind: TypeAttributeKind,
		config: Record<string, unknown>,
		key?: string,
	) => {
		setError("");
		const configErr = validateAttributeConfig(kind, config);
		if (configErr) {
			setError(configErr);
			return;
		}
		const body: Record<string, unknown> = {
			name,
			kind,
			config,
			indexed: indexableKinds.has(kind),
		};
		if (key) body.key = key;
		const res = await apiFetch(
			`/api/nooks/${props.nookId}/note-types/${props.typeId}/attributes/${attr.id}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
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

	const updateConfigOverrides = async (
		overrides: Record<string, Record<string, unknown>>,
	) => {
		const type = getType();
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
					config_overrides: overrides,
				}),
			},
		);
		if (!res.ok) {
			const text = await res.text();
			setError(text);
			return;
		}
		void props.store.loadNoteTypes();
		void refetch();
	};

	const onSaveOverride = async (
		attrId: string,
		configOverride: Record<string, unknown>,
	) => {
		const type = getType();
		if (!type) return;
		const attr = attributes()?.find((a) => a.id === attrId);
		if (attr) {
			const configErr = validateAttributeConfig(attr.kind, configOverride);
			if (configErr) {
				setError(configErr);
				return;
			}
		}
		const overrides = { ...type.configOverrides, [attrId]: configOverride };
		await updateConfigOverrides(overrides);
		setEditingId(null);
	};

	const onResetOverride = async (attrId: string) => {
		const type = getType();
		if (!type) return;
		const overrides = { ...type.configOverrides };
		delete overrides[attrId];
		await updateConfigOverrides(overrides);
	};

	const onHideInherited = async (attrId: string) => {
		const type = getType();
		if (!type) return;
		const overrides = { ...type.configOverrides, [attrId]: { hidden: true } };
		await updateConfigOverrides(overrides);
	};

	const onUnhideInherited = async (attrId: string) => {
		const type = getType();
		if (!type) return;
		const overrides = { ...type.configOverrides };
		delete overrides[attrId];
		await updateConfigOverrides(overrides);
	};

	const hiddenAttrs = (): Array<{ id: string; name: string }> => {
		const type = getType();
		if (!type) return [];
		const result: Array<{ id: string; name: string }> = [];
		for (const [attrId, override] of Object.entries(type.configOverrides)) {
			if (override && (override as Record<string, unknown>).hidden) {
				const allTypes = props.store.noteTypes();
				for (const t of allTypes) {
					const attr = t.attributes.find((a) => a.id === attrId);
					if (attr) {
						result.push({ id: attrId, name: attr.name });
						break;
					}
				}
			}
		}
		return result;
	};

	// Panel management
	const onAddPanel = async (
		key: string,
		label: string,
		position: PanelPosition,
	) => {
		const layout = getCurrentLayout();
		if (layout.panels.some((p) => p.key === key)) {
			setError(`Panel key "${key}" already exists`);
			return;
		}
		layout.panels.push({
			key,
			label,
			position,
			collapsible: true,
			attributes: [],
		});
		await saveLayout(layout);
		setAddingPanel(false);
	};

	const onDeletePanel = async (panelKey: string) => {
		const layout = getCurrentLayout();
		const panel = layout.panels.find((p) => p.key === panelKey);
		if (!panel) return;
		if (panel.position === "main") {
			setError("Cannot delete the main panel");
			return;
		}
		if (
			!window.confirm(
				`Delete panel "${panel.label || panelKey}"? Attributes will move to main.`,
			)
		)
			return;

		// Move attributes to main panel
		const mainPanel = layout.panels.find((p) => p.position === "main");
		if (mainPanel) {
			mainPanel.attributes = [...mainPanel.attributes, ...panel.attributes];
		}
		layout.panels = layout.panels.filter((p) => p.key !== panelKey);
		await saveLayout(layout);
	};

	const onUpdatePanel = async (
		panelKey: string,
		updates: { label?: string; position?: PanelPosition },
	) => {
		const layout = getCurrentLayout();
		const panel = layout.panels.find((p) => p.key === panelKey);
		if (!panel) return;
		if (updates.label !== undefined) panel.label = updates.label;
		if (updates.position !== undefined) panel.position = updates.position;
		await saveLayout(layout);
		setEditingPanelKey(null);
	};

	const otherPanelKeys = (
		currentPanelKey: string,
	): Array<{ key: string; label: string }> => {
		return getResolvedPanels()
			.filter((p) => p.key !== currentPanelKey)
			.map((p) => ({ key: p.key, label: p.label || p.key }));
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
				<h3 style={{ margin: 0 }}>Attributes & Panels</h3>
				<Show when={!adding()}>
					<Button size="small" onClick={() => setAdding(true)}>
						+ Attribute
					</Button>
				</Show>
				<Show when={!addingPanel()}>
					<Button
						size="small"
						variant="secondary"
						onClick={() => setAddingPanel(true)}
					>
						+ Panel
					</Button>
				</Show>
			</div>

			<Show when={addingPanel()}>
				<PanelAddRow
					onSave={(key, label, position) =>
						void onAddPanel(key, label, position)
					}
					onCancel={() => setAddingPanel(false)}
				/>
			</Show>

			<Show when={adding()}>
				<AttributeEditRow
					attr={{
						id: "",
						typeId: props.typeId,
						name: "",
						key: "",
						kind: "text",
						config: {},
						indexed: false,
						inherited: false,
						overridden: false,
						createdAt: undefined,
						updatedAt: undefined,
					}}
					onSave={(name, kind, config, key) =>
						void onAddSave(name, kind, config, key)
					}
					onCancel={() => setAdding(false)}
					nookId={props.nookId}
					store={props.store}
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

			<For each={getResolvedPanels()}>
				{(panel) => {
					const panelAttrs = () => attributesByPanel().get(panel.key) ?? [];
					return (
						<div style={{ "margin-bottom": "12px" }}>
							<Show
								when={editingPanelKey() === panel.key}
								fallback={
									<div
										style={{
											display: "flex",
											"align-items": "center",
											gap: "6px",
											"margin-bottom": "6px",
											padding: "4px 8px",
											background: "var(--color-bg-tertiary, #f5f5f5)",
											"border-radius": "4px",
										}}
									>
										<span
											style={{
												flex: 1,
												"font-size": "13px",
												"font-weight": "600",
											}}
										>
											{panel.label || panel.key}
											<span
												style={{
													color: "var(--color-text-muted)",
													"font-weight": "400",
													"margin-left": "6px",
													"font-size": "11px",
												}}
											>
												{panel.position}
											</span>
										</span>
										<Button
											size="small"
											variant="secondary"
											onClick={() => setEditingPanelKey(panel.key)}
										>
											Edit
										</Button>
										<Show when={panel.position !== "main"}>
											<Button
												size="small"
												variant="secondary"
												onClick={() => void onDeletePanel(panel.key)}
											>
												Del
											</Button>
										</Show>
									</div>
								}
							>
								<PanelEditRow
									panel={panel}
									onSave={(label, position) =>
										void onUpdatePanel(panel.key, { label, position })
									}
									onCancel={() => setEditingPanelKey(null)}
								/>
							</Show>

							<ul
								aria-label={`${panel.label || panel.key} panel attributes`}
								onDragOver={(e) => {
									if (draggingAttrId() === null) return;
									e.preventDefault();
								}}
								onDrop={(e) => {
									const id = draggingAttrId();
									if (id === null) return;
									e.preventDefault();
									// Drop on empty panel area = append to end.
									const beforeId = dropTargetAttrId();
									setDraggingAttrId(null);
									setDropTargetAttrId(null);
									setDropTargetPanelKey(null);
									void onDropAttribute(id, panel.key, beforeId);
								}}
								style={{
									"list-style": "none",
									padding: "2px",
									margin: 0,
									display: "grid",
									gap: "4px",
									outline:
										draggingAttrId() !== null &&
										dropTargetAttrId() === null &&
										dropTargetPanelKey() === panel.key
											? "2px dashed var(--color-accent, #3b82f6)"
											: "none",
									"outline-offset": "2px",
									"border-radius": "6px",
									"min-height": "28px",
								}}
							>
								<Show
									when={panelAttrs().length > 0}
									fallback={
										<li
											onDragEnter={() => {
												if (draggingAttrId() !== null) {
													setDropTargetAttrId(null);
													setDropTargetPanelKey(panel.key);
												}
											}}
											style={{
												color: "var(--color-text-muted)",
												"font-size": "12px",
												"padding-left": "8px",
											}}
										>
											No attributes in this panel. Drop one here to assign it.
										</li>
									}
								>
									<For each={panelAttrs()}>
										{(attr, index) => (
											<Show
												when={editingId() === attr.id}
												fallback={
													<AttributeRow
														attr={attr}
														panelKey={panel.key}
														otherPanels={otherPanelKeys(panel.key)}
														isDragging={draggingAttrId() === attr.id}
														isDropTarget={dropTargetAttrId() === attr.id}
														onDragStart={() => {
															setDraggingAttrId(attr.id);
															setDropTargetAttrId(null);
															setDropTargetPanelKey(null);
														}}
														onDragEnd={() => {
															setDraggingAttrId(null);
															setDropTargetAttrId(null);
															setDropTargetPanelKey(null);
														}}
														onDragOver={() => {
															if (draggingAttrId() === null) return;
															if (draggingAttrId() === attr.id) return;
															setDropTargetAttrId(attr.id);
															setDropTargetPanelKey(panel.key);
														}}
														onDragLeave={() => {
															if (dropTargetAttrId() === attr.id) {
																setDropTargetAttrId(null);
															}
														}}
														onDrop={() => {
															const id = draggingAttrId();
															if (id === null) return;
															const beforeId = attr.id;
															setDraggingAttrId(null);
															setDropTargetAttrId(null);
															setDropTargetPanelKey(null);
															void onDropAttribute(id, panel.key, beforeId);
														}}
														onEdit={() => setEditingId(attr.id)}
														onDelete={
															attr.inherited
																? undefined
																: () => void onDelete(attr)
														}
														onHide={
															attr.inherited
																? () => void onHideInherited(attr.id)
																: undefined
														}
														onReset={
															attr.overridden
																? () => void onResetOverride(attr.id)
																: undefined
														}
														onMoveUp={
															index() > 0
																? () =>
																		void onMoveWithinPanel(
																			panel.key,
																			attr.id,
																			"up",
																		)
																: undefined
														}
														onMoveDown={
															index() < panelAttrs().length - 1
																? () =>
																		void onMoveWithinPanel(
																			panel.key,
																			attr.id,
																			"down",
																		)
																: undefined
														}
														onMoveToPanel={(toPanelKey) =>
															void onMoveToPanel(attr.id, panel.key, toPanelKey)
														}
													/>
												}
											>
												<Show
													when={attr.inherited}
													fallback={
														<AttributeEditRow
															attr={attr}
															onSave={(name, kind, config, key) =>
																void onSaveEdit(attr, name, kind, config, key)
															}
															onCancel={() => setEditingId(null)}
															nookId={props.nookId}
															store={props.store}
														/>
													}
												>
													<InheritedConfigEditRow
														attr={attr}
														onSave={(config) =>
															void onSaveOverride(attr.id, config)
														}
														onCancel={() => setEditingId(null)}
														nookId={props.nookId}
														store={props.store}
													/>
												</Show>
											</Show>
										)}
									</For>
								</Show>
							</ul>
						</div>
					);
				}}
			</For>

			<Show when={hiddenAttrs().length > 0}>
				<div style={{ "margin-top": "12px" }}>
					<div
						style={{
							"font-size": "12px",
							color: "var(--color-text-muted)",
							"margin-bottom": "4px",
						}}
					>
						Hidden inherited attributes:
					</div>
					<div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
						<For each={hiddenAttrs()}>
							{(ha) => (
								<span
									style={{
										"font-size": "12px",
										padding: "2px 8px",
										"border-radius": "4px",
										background: "var(--color-bg-secondary)",
										border: "1px solid var(--color-border-light)",
										color: "var(--color-text-muted)",
									}}
								>
									{ha.name}
									<button
										type="button"
										onClick={() => void onUnhideInherited(ha.id)}
										style={{
											border: "none",
											background: "none",
											cursor: "pointer",
											padding: "0 0 0 4px",
											color: "var(--color-text-muted)",
											"font-size": "11px",
										}}
										title="Unhide"
									>
										&#10005;
									</button>
								</span>
							)}
						</For>
					</div>
				</div>
			</Show>
		</div>
	);
}

// ─── Panel Management Rows ──────────────────────────────────────────────────

function PanelAddRow(props: {
	onSave: (key: string, label: string, position: PanelPosition) => void;
	onCancel: () => void;
}) {
	const [key, setKey] = createSignal("");
	const [label, setLabel] = createSignal("");
	const [position, setPosition] = createSignal<PanelPosition>("side-right");

	return (
		<div
			style={{
				display: "grid",
				gap: "6px",
				padding: "8px",
				border: "1px solid var(--color-border-medium)",
				"border-radius": "6px",
				background: "var(--color-bg-secondary)",
				"margin-bottom": "8px",
			}}
		>
			<div style={{ "font-size": "13px", "font-weight": "600" }}>Add Panel</div>
			<div style={{ display: "flex", gap: "6px" }}>
				<input
					value={key()}
					onInput={(e) =>
						setKey(
							e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
						)
					}
					placeholder="Key (slug)"
					style={{ flex: 1, padding: "4px 6px" }}
				/>
				<input
					value={label()}
					onInput={(e) => setLabel(e.currentTarget.value)}
					placeholder="Label"
					style={{ flex: 1, padding: "4px 6px" }}
				/>
				<select
					value={position()}
					onChange={(e) => setPosition(e.currentTarget.value as PanelPosition)}
					style={{ padding: "4px 6px" }}
				>
					<For each={PanelPositions.filter((p) => p !== "main")}>
						{(p) => <option value={p}>{p}</option>}
					</For>
				</select>
			</div>
			<div style={{ display: "flex", gap: "6px" }}>
				<Button
					size="small"
					onClick={() => props.onSave(key(), label() || key(), position())}
				>
					Add
				</Button>
				<Button size="small" variant="secondary" onClick={props.onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function PanelEditRow(props: {
	panel: Panel;
	onSave: (label: string, position: PanelPosition) => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = createSignal(props.panel.label || props.panel.key);
	const [position, setPosition] = createSignal<PanelPosition>(
		props.panel.position,
	);

	return (
		<div
			style={{
				display: "flex",
				gap: "6px",
				padding: "6px 8px",
				background: "var(--color-bg-tertiary, #f5f5f5)",
				"border-radius": "4px",
				"margin-bottom": "6px",
				"align-items": "center",
			}}
		>
			<span
				style={{
					"font-size": "11px",
					color: "var(--color-text-muted)",
					"min-width": "40px",
				}}
			>
				{props.panel.key}
			</span>
			<input
				value={label()}
				onInput={(e) => setLabel(e.currentTarget.value)}
				placeholder="Label"
				style={{ flex: 1, padding: "4px 6px", "font-size": "13px" }}
			/>
			<Show when={props.panel.position !== "main"}>
				<select
					value={position()}
					onChange={(e) => setPosition(e.currentTarget.value as PanelPosition)}
					style={{ padding: "4px 6px", "font-size": "12px" }}
				>
					<For each={[...PanelPositions]}>
						{(p) => <option value={p}>{p}</option>}
					</For>
				</select>
			</Show>
			<Button size="small" onClick={() => props.onSave(label(), position())}>
				Save
			</Button>
			<Button size="small" variant="secondary" onClick={props.onCancel}>
				Cancel
			</Button>
		</div>
	);
}

// ─── Attribute Rows ─────────────────────────────────────────────────────────

function AttributeRow(props: {
	attr: TypeAttribute;
	panelKey: string;
	otherPanels: Array<{ key: string; label: string }>;
	isDragging?: boolean;
	isDropTarget?: boolean;
	onDragStart?: () => void;
	onDragEnd?: () => void;
	onDragOver?: () => void;
	onDragLeave?: () => void;
	onDrop?: () => void;
	onEdit: () => void;
	onDelete?: () => void;
	onHide?: () => void;
	onReset?: () => void;
	onMoveUp?: () => void;
	onMoveDown?: () => void;
	onMoveToPanel: (toPanelKey: string) => void;
}) {
	return (
		<li
			aria-label={`Attribute ${props.attr.name}`}
			draggable={true}
			onDragStart={(e) => {
				e.dataTransfer?.setData("text/plain", props.attr.id);
				if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
				props.onDragStart?.();
			}}
			onDragEnd={() => props.onDragEnd?.()}
			onDragOver={(e) => {
				// preventDefault is required for the drop event to fire.
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
				props.onDragOver?.();
			}}
			onDragLeave={() => props.onDragLeave?.()}
			onDrop={(e) => {
				e.preventDefault();
				e.stopPropagation();
				props.onDrop?.();
			}}
			style={{
				display: "flex",
				"align-items": "center",
				gap: "4px",
				padding: "6px 8px",
				border: props.isDropTarget
					? "2px solid var(--color-accent, #3b82f6)"
					: "1px solid var(--color-border-light)",
				"border-radius": "6px",
				background: props.attr.inherited
					? "var(--color-bg-secondary)"
					: "var(--color-bg)",
				opacity: props.isDragging ? 0.4 : 1,
				cursor: "grab",
				transition: "border-color 80ms ease",
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
						color: props.onMoveUp
							? "var(--color-text-secondary)"
							: "var(--color-border-light)",
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
						color: props.onMoveDown
							? "var(--color-text-secondary)"
							: "var(--color-border-light)",
					}}
					title="Move down"
				>
					&#9660;
				</button>
			</div>
			<span style={{ flex: 1, "font-size": "13px" }}>
				<strong>{props.attr.name}</strong>
				<span
					style={{
						color: "var(--color-text-faint)",
						"margin-left": "4px",
						"font-size": "11px",
					}}
				>
					{props.attr.key}
				</span>
				<span
					style={{ color: "var(--color-text-muted)", "margin-left": "6px" }}
				>
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
						{props.attr.overridden ? "(inherited · overridden)" : "(inherited)"}
					</span>
				</Show>
			</span>
			<Show when={props.otherPanels.length > 0}>
				<select
					style={{
						padding: "2px 4px",
						"font-size": "11px",
						color: "var(--color-text-muted)",
					}}
					value=""
					onChange={(e) => {
						const val = e.currentTarget.value;
						if (val) props.onMoveToPanel(val);
						e.currentTarget.value = "";
					}}
					title="Move to panel"
				>
					<option value="">Move to...</option>
					<For each={props.otherPanels}>
						{(p) => <option value={p.key}>{p.label}</option>}
					</For>
				</select>
			</Show>
			<Show when={props.attr.inherited}>
				<Button
					size="small"
					variant="secondary"
					onClick={props.onEdit}
					title="Override config"
				>
					Edit
				</Button>
				<Show when={props.onReset}>
					<Button
						size="small"
						variant="secondary"
						onClick={() => props.onReset?.()}
						title="Reset to inherited config"
					>
						Reset
					</Button>
				</Show>
				<Button
					size="small"
					variant="secondary"
					onClick={() => props.onHide?.()}
					title="Hide from this type"
				>
					Hide
				</Button>
			</Show>
			<Show when={!props.attr.inherited}>
				<Button size="small" variant="secondary" onClick={props.onEdit}>
					Edit
				</Button>
				<Show when={props.onDelete}>
					<Button
						size="small"
						variant="secondary"
						onClick={() => props.onDelete?.()}
					>
						Del
					</Button>
				</Show>
			</Show>
		</li>
	);
}

function InheritedConfigEditRow(props: {
	attr: TypeAttribute;
	onSave: (config: Record<string, unknown>) => void;
	onCancel: () => void;
	nookId: string;
	store: NookStore;
}) {
	let configState: KindConfigState | null = null;

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
			<div style={{ "font-size": "13px" }}>
				<strong>{props.attr.name}</strong>
				<span
					style={{ color: "var(--color-text-muted)", "margin-left": "6px" }}
				>
					{props.attr.kind} · override config
				</span>
			</div>

			<AttributeKindConfig
				kind={props.attr.kind}
				config={props.attr.config}
				nookId={props.nookId}
				store={props.store}
				ref={(s) => {
					configState = s;
				}}
			/>

			<div style={{ display: "flex", gap: "6px" }}>
				<Button
					size="small"
					onClick={() => props.onSave(configState?.buildConfig() ?? {})}
				>
					Save override
				</Button>
				<Button size="small" variant="secondary" onClick={props.onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function AttributeEditRow(props: {
	attr: TypeAttribute;
	onSave: (
		name: string,
		kind: TypeAttributeKind,
		config: Record<string, unknown>,
		key?: string,
	) => void;
	onCancel: () => void;
	nookId: string;
	store: NookStore;
}) {
	const [name, setName] = createSignal(props.attr.name);
	const [key, setKey] = createSignal(props.attr.key);
	const [kind, setKind] = createSignal<TypeAttributeKind>(props.attr.kind);
	// Kind is locked once an attribute exists. The empty id signals the
	// "add new attribute" flow, where the user is still choosing kind.
	// Existing per-note values are shape-specific (text vs graph config
	// vs linked_notes selection), so changing kind would silently
	// invalidate every stored value across every note of this type.
	const isNew = () => props.attr.id === "";
	let configState: KindConfigState | null = null;

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
				<input
					value={key()}
					onInput={(e) =>
						setKey(
							e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
						)
					}
					placeholder="Key (slug)"
					style={{
						width: "120px",
						padding: "4px 6px",
						"font-size": "12px",
						color: "var(--color-text-muted)",
					}}
				/>
				<select
					value={kind()}
					onChange={(e) => setKind(e.currentTarget.value as TypeAttributeKind)}
					disabled={!isNew()}
					title={
						isNew()
							? undefined
							: "Kind cannot be changed after creation — delete and recreate to change it"
					}
					style={{
						padding: "4px 6px",
						...(isNew() ? {} : { cursor: "not-allowed", opacity: "0.7" }),
					}}
				>
					<For each={[...TypeAttributeKinds]}>
						{(k) => <option value={k}>{k}</option>}
					</For>
				</select>
			</div>

			<AttributeKindConfig
				kind={kind()}
				config={props.attr.config}
				nookId={props.nookId}
				store={props.store}
				ref={(s) => {
					configState = s;
				}}
			/>

			<div style={{ display: "flex", gap: "6px" }}>
				<Button
					size="small"
					onClick={() =>
						props.onSave(
							name(),
							kind(),
							configState?.buildConfig() ?? {},
							key(),
						)
					}
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
