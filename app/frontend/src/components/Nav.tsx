import { A } from "@solidjs/router";
import styles from "./Nav.module.css";

export function Nav() {
	return (
		<nav class={styles.nav}>
			<A href="/" end activeClass={styles.active}>
				Home
			</A>
			<A href="/about" activeClass={styles.active}>
				About
			</A>
			<A href="/notes" activeClass={styles.active}>
				Notes
			</A>
		</nav>
	);
}
