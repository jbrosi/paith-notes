import { Show } from "solid-js";

type Props = {
	actor: string;
	userName: string;
};

/**
 * Displays actor attribution: "AI via John" or "John Doe"
 * Uses --color-ai for AI actor.
 */
export function ActorLabel(props: Props) {
	return (
		<Show
			when={props.actor === "ai"}
			fallback={<span>{props.userName || "Unknown"}</span>}
		>
			<span style={{ color: "var(--color-ai, #8b5cf6)", "font-weight": "500" }}>AI</span>
			{props.userName ? <span style={{ opacity: "0.7" }}>{" "}via {props.userName}</span> : null}
		</Show>
	);
}
