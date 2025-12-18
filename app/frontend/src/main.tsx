import { render } from "solid-js/web";
import App from "./App.tsx";
import ButtonDemo from "./ButtonDemo.tsx";

const root = document.getElementById("app");

if (root) {
	// Render ButtonDemo for showcase, or App for the original health check
	const showDemo = new URLSearchParams(window.location.search).get("demo");
	render(() => (showDemo === "button" ? <ButtonDemo /> : <App />), root);
}
