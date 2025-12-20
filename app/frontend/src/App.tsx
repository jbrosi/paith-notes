import type { RouteSectionProps } from "@solidjs/router";
import { Nav } from "./components/Nav";

export default function App(props: RouteSectionProps) {
	return (
		<>
			<Nav />
			{props.children}
		</>
	);
}
