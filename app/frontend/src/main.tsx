import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App.tsx";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import About from "./pages/About.tsx";
import Home from "./pages/Home.tsx";
import Notes from "./pages/Notes.tsx";

const root = document.getElementById("app");

if (root) {
	render(
		() => (
			<AuthProvider>
				<Router root={App}>
					<Route path="/" component={Home} />
					<Route path="/about" component={About} />
					<Route
						path="/notes"
						component={() => (
							<RequireAuth redirectTo="/notes">
								<Notes />
							</RequireAuth>
						)}
					/>
				</Router>
			</AuthProvider>
		),
		root,
	);
}
