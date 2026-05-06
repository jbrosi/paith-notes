import { Show } from "solid-js";
import type { NookStore } from "../store";

export function PrimaryTypeSelect(props: { store: NookStore }) {
	return (
		<div style={{ "margin-bottom": "1rem" }}>
			<div style={{ "margin-bottom": "0.5rem" }}>
				<div>
					<div>Primary type</div>
					<Show
						when={`${props.store.selectedId()}|${props.store.type()}|${props.store.noteTypes().length}`}
						keyed
					>
						{(_) => (
							<select
								value={props.store.typeId()}
								onChange={(e) => props.store.setTypeId(e.currentTarget.value)}
								disabled={props.store.mode() !== "edit"}
								style={{
									width: "100%",
									padding: "8px",
									"box-sizing": "border-box",
								}}
							>
								<option value="">(none)</option>
								{(() => {
									const current = props.store.typeId();
									const filtered = props.store
										.noteTypes()
										.filter(
											(t) =>
												t.appliesTo ===
												(props.store.type() === "file" ? "files" : "notes"),
										);
									if (current === "") return filtered;
									if (filtered.some((t) => t.id === current)) return filtered;
									const selected = props.store
										.noteTypes()
										.find((t) => t.id === current);
									if (selected) return [selected, ...filtered];
									return [
										{
											id: current,
											label: `(unknown type: ${current})`,
											key: "",
											nookId: "",
											parentId: "",
											appliesTo: "notes" as const,
											createdAt: undefined,
											updatedAt: undefined,
										},
										...filtered,
									];
								})().map((t) => (
									<option value={t.id}>{t.label}</option>
								))}
							</select>
						)}
					</Show>
				</div>
			</div>
		</div>
	);
}
