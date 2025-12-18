import { defineConfig } from "cypress";

export default defineConfig({
	component: {
		devServer: {
			framework: "solid",
			bundler: "vite",
		},
		specPattern: "src/**/*.cy.{ts,tsx}",
		supportFile: "cypress/support/component.ts",
	},
});
