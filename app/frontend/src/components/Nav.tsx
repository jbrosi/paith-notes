import { A } from "@solidjs/router";
import styles from "./Nav.module.css";

export function Nav() {
	return (
		<nav class={styles.nav}>
			<A href="/" end activeClass="active">
				Home
			</A>
			<A href="/about" activeClass="active">
				About
			</A>
			<A href="/nooks" activeClass="active">
				Notes
			</A>
		</nav>
	);
}
