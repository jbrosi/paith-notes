import styles from "./ButtonDemo.module.css";
import { Button } from "./components/Button";

export default function ButtonDemo() {
	return (
		<div class={styles.container}>
			<h1 class={styles.title}>Button Component Demo</h1>
			<p class={styles.subtitle}>
				This page showcases the Button component with Cypress component tests.
			</p>

			<section class={styles.section}>
				<h2 class={styles["section-title"]}>Variants</h2>
				<div class={styles["button-group"]}>
					<Button variant="primary">Primary</Button>
					<Button variant="secondary">Secondary</Button>
					<Button variant="danger">Danger</Button>
				</div>
			</section>

			<section class={styles.section}>
				<h2 class={styles["section-title"]}>Sizes</h2>
				<div class={styles["button-group"]}>
					<Button size="small">Small</Button>
					<Button size="medium">Medium</Button>
					<Button size="large">Large</Button>
				</div>
			</section>

			<section class={styles.section}>
				<h2 class={styles["section-title"]}>States</h2>
				<div class={styles["button-group"]}>
					<Button>Normal</Button>
					<Button disabled>Disabled</Button>
				</div>
			</section>

			<section class={styles.section}>
				<h2 class={styles["section-title"]}>Interactive Example</h2>
				<div class={styles["button-group"]}>
					<Button
						onClick={() => {
							alert("Primary button clicked!");
						}}
					>
						Click Me!
					</Button>
					<Button
						variant="secondary"
						onClick={() => {
							console.log("Secondary button clicked!");
						}}
					>
						Log to Console
					</Button>
				</div>
			</section>

			<section class={styles.section}>
				<h2 class={styles["section-title"]}>Testing</h2>
				<p class={styles["test-info"]}>
					This component has comprehensive Cypress component tests. Check{" "}
					<code>src/components/Button.cy.tsx</code> for test examples.
				</p>
				<p class={styles["test-info"]}>
					Run tests with: <code>npm run test:component</code> or{" "}
					<code>npm run test:component:open</code>
				</p>
			</section>
		</div>
	);
}
