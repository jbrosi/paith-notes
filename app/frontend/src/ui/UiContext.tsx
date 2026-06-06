import {
	createContext,
	createSignal,
	type JSX,
	onMount,
	useContext,
} from "solid-js";

/** Panel key for mobile swipe navigation. Dynamic based on type's attribute_layout. */
export type MobilePanel = string;

/** Default panel list when no layout is configured */
export const DEFAULT_MOBILE_PANELS: string[] = ["main"];

export type ThemeMode = "system" | "light" | "dark";

export type UiState = {
	mode: () => "view" | "edit";
	setMode: (next: "view" | "edit") => void;
	toggleMode: () => void;
	sidebarRightOpen: () => boolean;
	setSidebarRightOpen: (next: boolean) => void;
	toggleSidebarRight: () => void;
	sidebarLeftOpen: () => boolean;
	setSidebarLeftOpen: (next: boolean) => void;
	toggleSidebarLeft: () => void;
	typesPanelOpen: () => boolean;
	setTypesPanelOpen: (next: boolean) => void;
	toggleTypesPanel: () => void;
	chatPanelOpen: () => boolean;
	setChatPanelOpen: (next: boolean) => void;
	toggleChatPanel: () => void;
	activePanel: () => MobilePanel;
	setActivePanel: (next: MobilePanel) => void;
	/** Set the available mobile panels (driven by attribute_layout) */
	setMobilePanels: (panels: string[]) => void;
	mobilePanels: () => string[];
	nextPanel: () => void;
	prevPanel: () => void;
	theme: () => ThemeMode;
	setTheme: (next: ThemeMode) => void;
	cycleTheme: () => void;
	accentColor: () => string;
	setAccentColor: (color: string, nookId?: string) => void;
	resetAccentColor: (nookId?: string) => void;
	loadNookAccent: (nookId: string) => void;
	debugMode: () => boolean;
	setDebugMode: (next: boolean) => void;
	toggleDebugMode: () => void;
};

const UiContext = createContext<UiState>();

const SIDEBAR_RIGHT_STORAGE_KEY = "paith-notes:sidebarRightOpen";
const SIDEBAR_LEFT_STORAGE_KEY = "paith-notes:sidebarLeftOpen";
const TYPES_PANEL_OPEN_STORAGE_KEY = "paith-notes:typesPanelOpen";
const CHAT_PANEL_OPEN_STORAGE_KEY = "paith-notes:chatPanelOpen";
const ACTIVE_PANEL_STORAGE_KEY = "paith-notes:activePanel";
const THEME_STORAGE_KEY = "paith-notes:theme";
const DEBUG_MODE_STORAGE_KEY = "paith-notes:debugMode";

export function UiProvider(props: { children: JSX.Element }) {
	const [mode, setModeSignal] = createSignal<"view" | "edit">("view");
	const [sidebarRightOpen, setSidebarRightOpenSignal] = createSignal<boolean>(true);
	const [sidebarLeftOpen, setSidebarLeftOpenSignal] = createSignal<boolean>(false);
	const [typesPanelOpen, setTypesPanelOpenSignal] = createSignal<boolean>(true);
	const [chatPanelOpen, setChatPanelOpenSignal] = createSignal<boolean>(false);
	const [activePanel, setActivePanelSignal] =
		createSignal<MobilePanel>("main");
	const [mobilePanels, setMobilePanelsSignal] =
		createSignal<string[]>(DEFAULT_MOBILE_PANELS);
	const [theme, setThemeSignal] = createSignal<ThemeMode>("system");
	const [accentColor, setAccentColorSignal] = createSignal("");
	const [debugMode, setDebugModeSignal] = createSignal(false);

	onMount(() => {
		try {
			const v = window.localStorage.getItem(SIDEBAR_RIGHT_STORAGE_KEY);
			if (v === "0") setSidebarRightOpenSignal(false);
			if (v === "1") setSidebarRightOpenSignal(true);
		} catch { /* ignore */ }
		try {
			const v = window.localStorage.getItem(SIDEBAR_LEFT_STORAGE_KEY);
			if (v === "0") setSidebarLeftOpenSignal(false);
			if (v === "1") setSidebarLeftOpenSignal(true);
		} catch { /* ignore */ }
		try {
			const v = window.localStorage.getItem(TYPES_PANEL_OPEN_STORAGE_KEY);
			if (v === "0") setTypesPanelOpenSignal(false);
			if (v === "1") setTypesPanelOpenSignal(true);
		} catch { /* ignore */ }
		try {
			const v = window.localStorage.getItem(CHAT_PANEL_OPEN_STORAGE_KEY);
			if (v === "0") setChatPanelOpenSignal(false);
			if (v === "1") setChatPanelOpenSignal(true);
		} catch { /* ignore */ }
		try {
			const v = window.localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY);
			if (v) setActivePanelSignal(v);
		} catch { /* ignore */ }
		try {
			const v = window.localStorage.getItem(THEME_STORAGE_KEY);
			if (v === "light" || v === "dark" || v === "system") {
				setThemeSignal(v);
				applyTheme(v);
			}
		} catch { /* ignore */ }
		try {
			const v = window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY);
			if (v === "1") setDebugModeSignal(true);
		} catch { /* ignore */ }
	});

	const setMode = (next: "view" | "edit") => {
		setModeSignal(next);
	};

	const persistBool = (key: string, val: boolean) => {
		try { window.localStorage.setItem(key, val ? "1" : "0"); } catch { /* ignore */ }
	};

	const setSidebarRightOpen = (next: boolean) => {
		setSidebarRightOpenSignal(Boolean(next));
		persistBool(SIDEBAR_RIGHT_STORAGE_KEY, next);
	};

	const setSidebarLeftOpen = (next: boolean) => {
		setSidebarLeftOpenSignal(Boolean(next));
		persistBool(SIDEBAR_LEFT_STORAGE_KEY, next);
	};

	const setTypesPanelOpen = (next: boolean) => {
		setTypesPanelOpenSignal(Boolean(next));
		persistBool(TYPES_PANEL_OPEN_STORAGE_KEY, next);
	};

	const setChatPanelOpen = (next: boolean) => {
		setChatPanelOpenSignal(Boolean(next));
		persistBool(CHAT_PANEL_OPEN_STORAGE_KEY, next);
	};

	const setActivePanel = (next: MobilePanel) => {
		setActivePanelSignal(next);
		try { window.localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, next); } catch { /* ignore */ }
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
		try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* ignore */ }
	};

	let currentNookIdForAccent = "";

	const applyAccentColor = (color: string) => {
		if (color) {
			document.documentElement.style.setProperty("--seed-accent", color);
		} else {
			document.documentElement.style.removeProperty("--seed-accent");
		}
	};

	const currentModeStr = (): string => {
		const attr = document.documentElement.getAttribute("data-theme");
		if (attr === "dark") return "dark";
		if (attr === "light") return "light";
		return window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	};

	const accentStorageKey = (nookId: string) =>
		`paith-notes:seed:${nookId}:${currentModeStr()}:accent`;

	const setAccentColor = (color: string, nookId?: string) => {
		const id = nookId || currentNookIdForAccent;
		setAccentColorSignal(color);
		applyAccentColor(color);
		if (!id) return;
		try {
			const key = accentStorageKey(id);
			if (color) {
				window.localStorage.setItem(key, color);
			} else {
				window.localStorage.removeItem(key);
			}
		} catch { /* ignore */ }
	};

	const resetAccentColor = (nookId?: string) => setAccentColor("", nookId);

	const loadNookAccent = (nookId: string) => {
		currentNookIdForAccent = nookId;
		try {
			const v = window.localStorage.getItem(accentStorageKey(nookId));
			if (v && /^#[0-9a-f]{6}$/i.test(v)) {
				setAccentColorSignal(v);
				applyAccentColor(v);
			} else {
				setAccentColorSignal("");
				applyAccentColor("");
			}
		} catch { /* ignore */ }
	};

	const cycleTheme = () => {
		const order: ThemeMode[] = ["system", "light", "dark"];
		const idx = order.indexOf(theme());
		setTheme(order[(idx + 1) % order.length]);
	};

	const setMobilePanels = (panels: string[]) => {
		const list = panels.length > 0 ? panels : DEFAULT_MOBILE_PANELS;
		setMobilePanelsSignal(list);
		if (!list.includes(activePanel())) {
			setActivePanel(list[0]);
		}
	};

	const nextPanel = () => {
		const panels = mobilePanels();
		const idx = panels.indexOf(activePanel());
		setActivePanel(panels[(idx + 1) % panels.length]);
	};

	const prevPanel = () => {
		const panels = mobilePanels();
		const idx = panels.indexOf(activePanel());
		setActivePanel(
			panels[(idx - 1 + panels.length) % panels.length],
		);
	};

	const setDebugMode = (next: boolean) => {
		setDebugModeSignal(Boolean(next));
		persistBool(DEBUG_MODE_STORAGE_KEY, next);
	};
	const toggleDebugMode = () => setDebugMode(!debugMode());

	const toggleMode = () => setMode(mode() === "edit" ? "view" : "edit");
	const toggleSidebarRight = () => setSidebarRightOpen(!sidebarRightOpen());
	const toggleSidebarLeft = () => setSidebarLeftOpen(!sidebarLeftOpen());
	const toggleTypesPanel = () => setTypesPanelOpen(!typesPanelOpen());
	const toggleChatPanel = () => setChatPanelOpen(!chatPanelOpen());

	return (
		<UiContext.Provider
			value={{
				mode,
				setMode,
				toggleMode,
				sidebarRightOpen,
				setSidebarRightOpen,
				toggleSidebarRight,
				sidebarLeftOpen,
				setSidebarLeftOpen,
				toggleSidebarLeft,
				typesPanelOpen,
				setTypesPanelOpen,
				toggleTypesPanel,
				chatPanelOpen,
				setChatPanelOpen,
				toggleChatPanel,
				activePanel,
				setActivePanel,
				setMobilePanels,
				mobilePanels,
				nextPanel,
				prevPanel,
				theme,
				setTheme,
				cycleTheme,
				accentColor,
				setAccentColor,
				resetAccentColor,
				loadNookAccent,
				debugMode,
				setDebugMode,
				toggleDebugMode,
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
