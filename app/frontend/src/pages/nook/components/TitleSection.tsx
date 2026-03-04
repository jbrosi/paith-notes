import { Show } from "solid-js";
import type { NookStore } from "../store";

export function TitleSection(props: {
	store: NookStore;
	primaryTypeLabel: () => string;
}) {
	return (
		<Show
			when={
				props.store.type() !== "file" ||
				(props.store.fileFilename() !== "" &&
					!props.store.fileUploadInProgress())
			}
		>
			<div style={{ "margin-bottom": "0.5rem" }}>
				<Show
					when={props.store.mode() === "edit"}
					fallback={
						<h1 style={{ margin: "0 0 0.25rem", "font-size": "22px" }}>
							{props.primaryTypeLabel().trim() !== ""
								? `${props.primaryTypeLabel()}: ${props.store.title() || "(untitled)"}`
								: props.store.title() || "(untitled)"}
						</h1>
					}
				>
					<label>
						Title
						<input
							type="text"
							value={props.store.title()}
							onInput={(e) => props.store.setTitle(e.currentTarget.value)}
							style={{
								width: "100%",
								padding: "8px",
								"box-sizing": "border-box",
							}}
						/>
					</label>
				</Show>
			</div>
		</Show>
	);
}
