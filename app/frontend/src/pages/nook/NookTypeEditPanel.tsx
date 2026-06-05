import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../../components/Button";
import { TypeAttributeEditor } from "./components/TypeAttributeEditor";
import type { NookStore } from "./store";

export type NookTypeEditPanelProps = {
	store: NookStore;
	typeId: string;
};

export function NookTypeEditPanel(props: NookTypeEditPanelProps) {
	const navigate = useNavigate();
	const store = () => props.store;

	const type = createMemo(() => {
		const tid = props.typeId.trim();
		if (tid === "") return null;
		return (
			store()
				.noteTypes()
				.find((t) => t.id === tid) ?? null
		);
	});

	const [key, setKey] = createSignal<string>("");
	const [label, setLabel] = createSignal<string>("");
	const [description, setDescription] = createSignal<string>("");
	const [parentId, setParentId] = createSignal<string>("");

	createEffect(() => {
		const t = type();
		if (!t) return;
		setKey(t.key);
		setLabel(t.label);
		setDescription(t.description);
		setParentId(t.parentId);
	});

	// Types that can be a parent: any type except self and own descendants
	const availableParents = createMemo(() => {
		const tid = props.typeId.trim();
		const types = store().noteTypes();
		// Collect all descendant IDs to prevent circular parent
		const descendants = new Set<string>();
		const collectDescendants = (id: string) => {
			for (const t of types) {
				if (t.parentId === id && !descendants.has(t.id)) {
					descendants.add(t.id);
					collectDescendants(t.id);
				}
			}
		};
		collectDescendants(tid);
		return types.filter((t) => t.id !== tid && !descendants.has(t.id));
	});

	const goBack = () => {
		navigate(`/nooks/${store().nookId()}/settings/types`, { replace: true });
	};

	const onSave = async () => {
		const t = type();
		if (!t) return;
		const updated = await store().updateNoteType(t, {
			key: key(),
			label: label(),
			description: description(),
			parentId: parentId(),
		});
		if (updated) goBack();
	};

	return (
		<div
			style={{
				padding: "12px",
				border: "1px solid #eee",
				"border-radius": "8px",
			}}
		>
			<h2 style={{ margin: "0 0 12px 0" }}>Edit type</h2>

			<Show when={type()} fallback={<div>Type not found.</div>}>
				<div style={{ display: "grid", gap: "10px" }}>
					<label>
						<div
							style={{
								"font-size": "12px",
								color: "#666",
								"margin-bottom": "4px",
							}}
						>
							Key (slug)
						</div>
						<input
							value={key()}
							onInput={(e) => setKey(e.currentTarget.value)}
							style={{
								width: "100%",
								padding: "8px",
								"box-sizing": "border-box",
							}}
						/>
					</label>

					<label>
						<div
							style={{
								"font-size": "12px",
								color: "#666",
								"margin-bottom": "4px",
							}}
						>
							Label
						</div>
						<input
							value={label()}
							onInput={(e) => setLabel(e.currentTarget.value)}
							style={{
								width: "100%",
								padding: "8px",
								"box-sizing": "border-box",
							}}
						/>
					</label>

					<label>
						<div
							style={{
								"font-size": "12px",
								color: "#666",
								"margin-bottom": "4px",
							}}
						>
							Description
						</div>
						<textarea
							value={description()}
							onInput={(e) => setDescription(e.currentTarget.value)}
							rows={6}
							style={{
								width: "100%",
								padding: "8px",
								"box-sizing": "border-box",
							}}
						/>
					</label>

					<label>
						<div
							style={{
								"font-size": "12px",
								color: "#666",
								"margin-bottom": "4px",
							}}
						>
							Parent type
						</div>
						<select
							value={parentId()}
							onChange={(e) => setParentId(e.currentTarget.value)}
							style={{
								width: "100%",
								padding: "8px",
								"box-sizing": "border-box",
							}}
						>
							<option value="">(none — root type)</option>
							<For each={availableParents()}>
								{(t) => <option value={t.id}>{t.label} ({t.key})</option>}
							</For>
						</select>
					</label>

					<Show when={store().error() !== ""}>
						<pre
							style={{ margin: 0, color: "#b00020", "white-space": "pre-wrap" }}
						>
							{store().error()}
						</pre>
					</Show>

					<div style={{ display: "flex", gap: "8px", "align-items": "center" }}>
						<Button variant="secondary" onClick={goBack}>
							Cancel
						</Button>
						<Button onClick={() => void onSave()} disabled={store().loading()}>
							Save
						</Button>
					</div>
				</div>

				<TypeAttributeEditor nookId={store().nookId()} typeId={props.typeId} store={store()} />
			</Show>
		</div>
	);
}
