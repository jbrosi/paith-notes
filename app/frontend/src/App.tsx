import type { RouteSectionProps } from "@solidjs/router";
import styles from "./App.module.css";
import { Nav } from "./components/Nav";
import { NookProvider } from "./pages/nook/NookContext";

export default function App(props: RouteSectionProps) {
	return (
		<NookProvider>
			<div class={styles.appShell}>
				<Nav />
				<div class={styles.appContent}>{props.children}</div>
			</div>
		</NookProvider>
	);
}
