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
	graphPanelOpen: () => boolean;
	setGraphPanelOpen: (next: boolean) => void;
	toggleGraphPanel: () => void;
	typesPanelOpen: () => boolean;
	setTypesPanelOpen: (next: boolean) => void;
	toggleTypesPanel: () => void;
};

const UiContext = createContext<UiState>();

const MODE_STORAGE_KEY = "paith-notes:mode";
const GRAPH_PANEL_OPEN_STORAGE_KEY = "paith-notes:graphPanelOpen";
const TYPES_PANEL_OPEN_STORAGE_KEY = "paith-notes:typesPanelOpen";

export function UiProvider(props: { children: JSX.Element }) {
	const [mode, setModeSignal] = createSignal<"view" | "edit">("view");
	const [graphPanelOpen, setGraphPanelOpenSignal] = createSignal<boolean>(true);
	const [typesPanelOpen, setTypesPanelOpenSignal] = createSignal<boolean>(true);

	onMount(() => {
		try {
			const v = window.localStorage.getItem(MODE_STORAGE_KEY);
			if (v === "edit" || v === "view") setModeSignal(v);
		} catch {
			// ignore
		}
		try {
			const v = window.localStorage.getItem(GRAPH_PANEL_OPEN_STORAGE_KEY);
			if (v === "0") setGraphPanelOpenSignal(false);
			if (v === "1") setGraphPanelOpenSignal(true);
		} catch {
			// ignore
		}
		try {
			const v = window.localStorage.getItem(TYPES_PANEL_OPEN_STORAGE_KEY);
			if (v === "0") setTypesPanelOpenSignal(false);
			if (v === "1") setTypesPanelOpenSignal(true);
		} catch {
			// ignore
		}
	});

	const setMode = (next: "view" | "edit") => {
		setModeSignal(next);
		try {
			window.localStorage.setItem(MODE_STORAGE_KEY, next);
		} catch {
			// ignore
		}
	};

	const setGraphPanelOpen = (next: boolean) => {
		setGraphPanelOpenSignal(Boolean(next));
		try {
			window.localStorage.setItem(
				GRAPH_PANEL_OPEN_STORAGE_KEY,
				next ? "1" : "0",
			);
		} catch {
			// ignore
		}
	};

	const setTypesPanelOpen = (next: boolean) => {
		setTypesPanelOpenSignal(Boolean(next));
		try {
			window.localStorage.setItem(
				TYPES_PANEL_OPEN_STORAGE_KEY,
				next ? "1" : "0",
			);
		} catch {
			// ignore
		}
	};

	const toggleMode = () => setMode(mode() === "edit" ? "view" : "edit");
	const toggleGraphPanel = () => setGraphPanelOpen(!graphPanelOpen());
	const toggleTypesPanel = () => setTypesPanelOpen(!typesPanelOpen());

	return (
		<UiContext.Provider
			value={{
				mode,
				setMode,
				toggleMode,
				graphPanelOpen,
				setGraphPanelOpen,
				toggleGraphPanel,
				typesPanelOpen,
				setTypesPanelOpen,
				toggleTypesPanel,
			}}
		>
			{props.children}
		</UiContext.Provider>
	);
}

export function useUi(): UiState {
	const ctx = useContext(UiContext);
	if (!ctx) throw new Error("UiProvider is missing");
	return ctx;
}
