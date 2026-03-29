import {
	createContext,
	createSignal,
	type JSX,
	onMount,
	useContext,
} from "solid-js";

export type MobilePanel = "content" | "links" | "graph" | "chat" | "markdown";

export const MOBILE_PANELS: MobilePanel[] = [
	"content",
	"links",
	"graph",
	"chat",
	"markdown",
];

export type ThemeMode = "system" | "light" | "dark";

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
	chatPanelOpen: () => boolean;
	setChatPanelOpen: (next: boolean) => void;
	toggleChatPanel: () => void;
	activePanel: () => MobilePanel;
	setActivePanel: (next: MobilePanel) => void;
	nextPanel: () => void;
	prevPanel: () => void;
	theme: () => ThemeMode;
	setTheme: (next: ThemeMode) => void;
	cycleTheme: () => void;
	accentColor: () => string;
	setAccentColor: (color: string) => void;
	resetAccentColor: () => void;
};

const UiContext = createContext<UiState>();

const MODE_STORAGE_KEY = "paith-notes:mode";
const GRAPH_PANEL_OPEN_STORAGE_KEY = "paith-notes:graphPanelOpen";
const TYPES_PANEL_OPEN_STORAGE_KEY = "paith-notes:typesPanelOpen";
const CHAT_PANEL_OPEN_STORAGE_KEY = "paith-notes:chatPanelOpen";
const ACTIVE_PANEL_STORAGE_KEY = "paith-notes:activePanel";
const THEME_STORAGE_KEY = "paith-notes:theme";
const ACCENT_COLOR_STORAGE_KEY = "paith-notes:accentColor";

export function UiProvider(props: { children: JSX.Element }) {
	const [mode, setModeSignal] = createSignal<"view" | "edit">("view");
	const [graphPanelOpen, setGraphPanelOpenSignal] = createSignal<boolean>(true);
	const [typesPanelOpen, setTypesPanelOpenSignal] = createSignal<boolean>(true);
	const [chatPanelOpen, setChatPanelOpenSignal] = createSignal<boolean>(false);
	const [activePanel, setActivePanelSignal] =
		createSignal<MobilePanel>("content");
	const [theme, setThemeSignal] = createSignal<ThemeMode>("system");
	const [accentColor, setAccentColorSignal] = createSignal("");

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
		try {
			const v = window.localStorage.getItem(CHAT_PANEL_OPEN_STORAGE_KEY);
			if (v === "0") setChatPanelOpenSignal(false);
			if (v === "1") setChatPanelOpenSignal(true);
		} catch {
			// ignore
		}
		try {
			const v = window.localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY);
			if (v === "content" || v === "links" || v === "graph" || v === "chat")
				setActivePanelSignal(v);
		} catch {
			// ignore
		}
		try {
			const v = window.localStorage.getItem(THEME_STORAGE_KEY);
			if (v === "light" || v === "dark" || v === "system") {
				setThemeSignal(v);
				applyTheme(v);
			}
		} catch {
			// ignore
		}
		try {
			const v = window.localStorage.getItem(ACCENT_COLOR_STORAGE_KEY);
			if (v && /^#[0-9a-f]{6}$/i.test(v)) {
				setAccentColorSignal(v);
				applyAccentColor(v);
			}
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

	const setChatPanelOpen = (next: boolean) => {
		setChatPanelOpenSignal(Boolean(next));
		try {
			window.localStorage.setItem(
				CHAT_PANEL_OPEN_STORAGE_KEY,
				next ? "1" : "0",
			);
		} catch {
			// ignore
		}
	};

	const setActivePanel = (next: MobilePanel) => {
		setActivePanelSignal(next);
		try {
			window.localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, next);
		} catch {
			// ignore
		}
	};

	const applyTheme = (t: ThemeMode) => {
		if (t === "system") {
			document.documentElement.removeAttribute("data-theme");
		} else {
			document.documentElement.setAttribute("data-theme", t);
		}
	};

	const setTheme = (next: ThemeMode) => {
		setThemeSignal(next);
		applyTheme(next);
		try {
			window.localStorage.setItem(THEME_STORAGE_KEY, next);
		} catch {
			// ignore
		}
	};

	const applyAccentColor = (color: string) => {
		if (color) {
			document.documentElement.style.setProperty("--seed-accent", color);
		} else {
			document.documentElement.style.removeProperty("--seed-accent");
		}
	};

	const setAccentColor = (color: string) => {
		setAccentColorSignal(color);
		applyAccentColor(color);
		try {
			if (color) {
				window.localStorage.setItem(ACCENT_COLOR_STORAGE_KEY, color);
			} else {
				window.localStorage.removeItem(ACCENT_COLOR_STORAGE_KEY);
			}
		} catch {
			// ignore
		}
	};

	const resetAccentColor = () => setAccentColor("");

	const cycleTheme = () => {
		const order: ThemeMode[] = ["system", "light", "dark"];
		const idx = order.indexOf(theme());
		setTheme(order[(idx + 1) % order.length]);
	};

	const nextPanel = () => {
		const idx = MOBILE_PANELS.indexOf(activePanel());
		setActivePanel(MOBILE_PANELS[(idx + 1) % MOBILE_PANELS.length]);
	};

	const prevPanel = () => {
		const idx = MOBILE_PANELS.indexOf(activePanel());
		setActivePanel(
			MOBILE_PANELS[(idx - 1 + MOBILE_PANELS.length) % MOBILE_PANELS.length],
		);
	};

	const toggleMode = () => setMode(mode() === "edit" ? "view" : "edit");
	const toggleGraphPanel = () => setGraphPanelOpen(!graphPanelOpen());
	const toggleTypesPanel = () => setTypesPanelOpen(!typesPanelOpen());
	const toggleChatPanel = () => setChatPanelOpen(!chatPanelOpen());

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
				chatPanelOpen,
				setChatPanelOpen,
				toggleChatPanel,
				activePanel,
				setActivePanel,
				nextPanel,
				prevPanel,
				theme,
				setTheme,
				cycleTheme,
				accentColor,
				setAccentColor,
				resetAccentColor,
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
