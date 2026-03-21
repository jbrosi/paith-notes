import { useNavigate } from "@solidjs/router";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { Button } from "../../components/Button";
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

	createEffect(() => {
		const t = type();
		if (!t) return;
		setKey(t.key);
		setLabel(t.label);
		setDescription(t.description);
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
			parentId: t.parentId,
			appliesToFiles: t.appliesToFiles,
			appliesToNotes: t.appliesToNotes,
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
			</Show>
		</div>
	);
}
