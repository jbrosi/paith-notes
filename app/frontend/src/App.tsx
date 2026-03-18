import type { RouteSectionProps } from "@solidjs/router";
import { Nav } from "./components/Nav";
import { NookProvider } from "./pages/nook/NookContext";

export default function App(props: RouteSectionProps) {
	return (
		<NookProvider>
			<Nav />
			{props.children}
		</NookProvider>
	);
}
