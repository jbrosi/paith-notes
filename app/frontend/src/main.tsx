import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import App from "./App.tsx";
import About from "./pages/About.tsx";
import Home from "./pages/Home.tsx";
import Notes from "./pages/Notes.tsx";

const root = document.getElementById("app");

if (root) {
	render(
		() => (
			<Router root={App}>
				<Route path="/" component={Home} />
				<Route path="/about" component={About} />
				<Route path="/notes" component={Notes} />
			</Router>
		),
		root,
	);
}
