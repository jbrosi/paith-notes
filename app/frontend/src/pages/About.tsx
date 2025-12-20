import styles from "../App.module.css";

export default function About() {
	return (
		<main class={styles.container}>
			<h1 class={styles.title}>About Paith Notes</h1>
			<p class={styles.subtitle}>A simple note-taking application</p>
			<div>
				<p>
					Paith Notes is a modern note-taking application built with SolidJS.
				</p>
				<p>Features:</p>
				<ul>
					<li>Fast and reactive UI</li>
					<li>Simple and intuitive interface</li>
					<li>Built with modern web technologies</li>
				</ul>
			</div>
		</main>
	);
}
