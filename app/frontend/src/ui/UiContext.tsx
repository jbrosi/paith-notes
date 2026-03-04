import {
	createContext,
	createSignal,
	type JSX,
	onMount,
	useContext,
} from "solid-js";

export type UiState = {
	mode: () => "view" | "edit";
	setMode: (next: "view" | "edit") => void;
	toggleMode: () => void;
};

const UiContext = createContext<UiState>();

const STORAGE_KEY = "paith-notes:mode";

export function UiProvider(props: { children: JSX.Element }) {
	const [mode, setModeSignal] = createSignal<"view" | "edit">("view");

	onMount(() => {
		try {
			const v = window.localStorage.getItem(STORAGE_KEY);
			if (v === "edit" || v === "view") setModeSignal(v);
		} catch {
			// ignore
		}
	});

	const setMode = (next: "view" | "edit") => {
		setModeSignal(next);
		try {
			window.localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// ignore
		}
	};

	const toggleMode = () => setMode(mode() === "edit" ? "view" : "edit");

	return (
		<UiContext.Provider value={{ mode, setMode, toggleMode }}>
			{props.children}
		</UiContext.Provider>
	);
}

export function useUi(): UiState {
	const ctx = useContext(UiContext);
	if (!ctx) throw new Error("UiProvider is missing");
	return ctx;
}
