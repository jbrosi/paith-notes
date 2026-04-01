import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App.tsx";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import About from "./pages/About.tsx";
import Home from "./pages/Home.tsx";
import Nook from "./pages/Nook.tsx";
import NooksRedirect from "./pages/NooksRedirect.tsx";
import "./styles/theme.css";
import "./styles/milkdown-overrides.css";
import { UiProvider } from "./ui/UiContext";

const root = document.getElementById("app");

if (root) {
	render(
		() => (
			<AuthProvider>
				<UiProvider>
					<Router root={App}>
						<Route path="/" component={Home} />
						<Route path="/about" component={About} />
						<Route
							path="/notes"
							component={() => (
								<RequireAuth redirectTo="/notes">
									<NooksRedirect />
								</RequireAuth>
							)}
						/>
						<Route
							path="/nooks"
							component={() => (
								<RequireAuth redirectTo="/nooks">
									<NooksRedirect />
								</RequireAuth>
							)}
						/>
						<Route
							path="/nooks/:nookId/*path"
							component={() => (
								<RequireAuth redirectTo="/nooks">
									<Nook />
								</RequireAuth>
							)}
						/>
					</Router>
				</UiProvider>
			</AuthProvider>
		),
		root,
	);
}

// Register service worker for PWA install prompt
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js").catch(() => {
		// best-effort
	});
}
