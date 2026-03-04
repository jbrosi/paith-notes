import { Show } from "solid-js";
import { MilkdownEditor } from "../../../components/MilkdownEditor";
import type { NookStore } from "../store";

export function EditorSection(props: { store: NookStore }) {
	return (
		<Show
			when={
				props.store.type() !== "file" ||
				(props.store.fileFilename() !== "" &&
					!props.store.fileUploadInProgress())
			}
		>
			<div
				style={{
					border: "1px solid #eee",
					"border-radius": "6px",
					overflow: "hidden",
				}}
			>
				<MilkdownEditor
					value={props.store.content()}
					onChange={props.store.setContent}
					readonly={props.store.mode() !== "edit"}
					onNoteLinkClick={(id) => void props.store.onNoteLinkClick(id)}
					resolveEmbeddedImageSrc={(id) =>
						props.store.resolveEmbeddedImageSrc(id)
					}
					uploadEmbeddedImage={(f) => props.store.uploadEmbeddedImage(f)}
				/>
			</div>
		</Show>
	);
}
