import type { RouteSectionProps } from "@solidjs/router";
import { Nav } from "./components/Nav";
import { NookProvider } from "./pages/nook/NookContext";

export default function App(props: RouteSectionProps) {
	return (
		<NookProvider>
			<div
				style={{
					display: "flex",
					"flex-direction": "column",
					height: "100%",
				}}
			>
				<Nav />
				<div style={{ flex: "1", "min-height": "0", overflow: "hidden" }}>
					{props.children}
				</div>
			</div>
		</NookProvider>
	);
}
