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
