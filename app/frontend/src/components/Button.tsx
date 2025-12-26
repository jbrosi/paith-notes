import { type JSX, splitProps } from "solid-js";
import styles from "./Button.module.css";

export type ButtonProps = {
	variant?: "primary" | "secondary" | "danger";
	size?: "small" | "medium" | "large";
	children: JSX.Element;
} & JSX.ButtonHTMLAttributes<HTMLButtonElement>;

export function Button(props: ButtonProps) {
	const [local, others] = splitProps(props, [
		"variant",
		"size",
		"children",
		"class",
	]);

	const variant = () => local.variant || "primary";
	const size = () => local.size || "medium";

	const buttonClass = () => {
		const classes = [styles.button, styles[variant()], styles[size()]];
		if (local.class) {
			classes.push(local.class);
		}
		return classes.join(" ");
	};

	return (
		<button
			type="button"
			class={buttonClass()}
			data-variant={variant()}
			data-size={size()}
			{...others}
		>
			{local.children}
		</button>
	);
}
