import { A } from "@solidjs/router";
import { Show } from "solid-js";
import { useAuth } from "../auth/AuthContext";
import { useUi } from "../ui/UiContext";
import { Button } from "./Button";
import styles from "./Nav.module.css";

export function Nav() {
	const auth = useAuth();
	const ui = useUi();

	return (
		<nav class={styles.nav}>
			<div class={styles.links}>
				<A href="/" end activeClass="active">
					Home
				</A>
				<A href="/about" activeClass="active">
					About
				</A>
				<A href="/nooks" activeClass="active">
					Notes
				</A>
			</div>
			<Show when={auth.ready() && auth.authenticated()}>
				<div class={styles.actions}>
					<Button
						variant="secondary"
						size="small"
						onClick={() => ui.toggleMode()}
					>
						Mode: {ui.mode() === "edit" ? "Edit" : "View"}
					</Button>
					<Button
						variant="secondary"
						size="small"
						onClick={() => auth.logout()}
					>
						Logout
					</Button>
					<Button
						variant="secondary"
						size="small"
						onClick={() => auth.logoutSso()}
					>
						Logout SSO
					</Button>
				</div>
			</Show>
		</nav>
	);
}
