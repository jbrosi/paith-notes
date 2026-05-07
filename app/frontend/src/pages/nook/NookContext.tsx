import { createContext, createSignal, type JSX, useContext } from "solid-js";
import type { NookStore } from "./store";

export type NookContextValue = {
	store: () => NookStore | null;
	setStore: (next: NookStore | null) => void;
};

const NookContext = createContext<NookContextValue>();

export function NookProvider(props: { children: JSX.Element }) {
	const [store, setStoreSignal] = createSignal<NookStore | null>(null);

	const setStore = (next: NookStore | null) => {
		setStoreSignal(next);
	};

	return (
		<NookContext.Provider value={{ store, setStore }}>
			{props.children}
		</NookContext.Provider>
	);
}

export function useNook(): NookContextValue {
	const ctx = useContext(NookContext);
	if (!ctx) throw new Error("NookProvider is missing");
	return ctx;
}

/** Hook for resolving note titles and nook names from the store. */
export function useNoteResolver(): {
	resolveTitle: (id: string, nookId?: string) => string | undefined;
	resolveNookName: (nookId: string) => string | undefined;
	currentNookId: () => string;
	fetchMissing: (refs: Array<{ nookId: string; noteId: string }>) => void;
} {
	const nook = useContext(NookContext);
	return {
		resolveTitle: (id: string, forNookId?: string) =>
			nook?.store()?.resolveNoteTitle(id, forNookId),
		resolveNookName: (nookId: string) => nook?.store()?.resolveNookName(nookId),
		currentNookId: () => nook?.store()?.nookId() ?? "",
		fetchMissing: (refs) => nook?.store()?.fetchMissingTitles(refs),
	};
}
