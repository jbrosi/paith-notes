import { Button } from "../../components/Button";

type Props = {
	onSave: () => void;
	onDiscard: () => void;
	onCancel: () => void;
};

export function UnsavedChangesDialog(props: Props) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			style={{
				position: "fixed",
				inset: "0",
				background: "rgba(0,0,0,0.4)",
				display: "flex",
				"align-items": "center",
				"justify-content": "center",
				"z-index": "1000",
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) props.onCancel();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") props.onCancel();
			}}
		>
			<div
				style={{
					background: "var(--color-bg, #fff)",
					border: "1px solid var(--color-border, #ddd)",
					"border-radius": "8px",
					padding: "24px",
					"max-width": "360px",
					width: "100%",
					display: "flex",
					"flex-direction": "column",
					gap: "16px",
				}}
			>
				<p style={{ margin: "0", "font-size": "0.95rem" }}>
					You have unsaved changes. What would you like to do?
				</p>
				<div
					style={{ display: "flex", gap: "8px", "justify-content": "flex-end" }}
				>
					<Button variant="secondary" size="small" onClick={props.onCancel}>
						Cancel
					</Button>
					<Button variant="danger" size="small" onClick={props.onDiscard}>
						Discard
					</Button>
					<Button variant="primary" size="small" onClick={props.onSave}>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
}
