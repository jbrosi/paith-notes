import { Button } from "../../components/Button";

export type NookSettingsLandingProps = {
	onClose: () => void;
	onOpenLinks: () => void;
	onOpenTypes: () => void;
};

export function NookSettingsLanding(props: NookSettingsLandingProps) {
	return (
		<div style={{ width: "100%" }}>
			<div style={{ padding: "12px" }}>
				<div style={{ "font-weight": 600, "margin-bottom": "12px" }}>
					Nook settings
				</div>
				<div style={{ display: "flex", gap: "8px" }}>
					<Button variant="secondary" size="small" onClick={props.onOpenLinks}>
						Links settings
					</Button>
					<Button variant="secondary" size="small" onClick={props.onOpenTypes}>
						Types settings
					</Button>
				</div>
			</div>
		</div>
	);
}
