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
	e2e: {
		baseUrl: "http://localhost:8000",
		specPattern: "cypress/e2e/**/*.cy.{ts,tsx}",
		supportFile: "cypress/support/e2e.ts",
	},
});
