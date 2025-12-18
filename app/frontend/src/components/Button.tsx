import { JSX } from "solid-js";
import styles from "./Button.module.css";

type ButtonProps = {
	children: JSX.Element;
	onClick?: () => void;
	variant?: "primary" | "secondary" | "danger";
	disabled?: boolean;
	type?: "button" | "submit" | "reset";
};

export default function Button(props: ButtonProps) {
	const variant = () => props.variant || "primary";
	const type = () => props.type || "button";

	return (
		<button
			type={type()}
			onClick={props.onClick}
			disabled={props.disabled}
			class={`${styles.button} ${styles[variant()]}`}
		>
			{props.children}
		</button>
	);
}
