describe("Routing E2E Tests", () => {
	const CYPRESS_NOOK_ID = "00000000-0000-0000-0000-000000000000";

	beforeEach(() => {
		cy.visit("/");
	});

	it("displays navigation with all route links", () => {
		cy.get("nav").should("exist");
		cy.get("nav").within(() => {
			cy.get("a").should("have.length", 3);
			cy.contains("a", "Home").should("have.attr", "href", "/");
			cy.contains("a", "About").should("have.attr", "href", "/about");
			cy.contains("a", "Notes").should("have.attr", "href", "/nooks");
		});
	});

	it("highlights active route in navigation", () => {
		// Home should be active by default
		cy.get("nav").within(() => {
			cy.contains("a", "Home").should("have.class", "active");
			cy.contains("a", "About").should("not.have.class", "active");
			cy.contains("a", "Notes").should("not.have.class", "active");
		});
	});

	it("navigates to About page", () => {
		cy.get("nav").within(() => {
			cy.contains("a", "About").click();
		});
		cy.url().should("include", "/about");
		cy.contains("h1", "About Paith Notes").should("be.visible");
		cy.contains("A simple note-taking application").should("be.visible");
		cy.get("nav").within(() => {
			cy.contains("a", "About").should("have.class", "active");
		});
	});

	it("navigates to Notes page", () => {
		cy.get("nav").within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.url().should("include", `/nooks/${CYPRESS_NOOK_ID}`);
		cy.contains("h1", "My Notes").should("be.visible");
		cy.contains("Manage your notes here").should("be.visible");
		cy.get("nav").within(() => {
			cy.contains("a", "Notes").should("have.class", "active");
		});
	});

	it("displays default notes on Notes page", () => {
		cy.get("nav").within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.contains("h3", "First Note").should("be.visible");
		cy.contains("This is my first note").should("be.visible");
		cy.contains("h3", "Second Note").should("be.visible");
		cy.contains("This is my second note").should("be.visible");
	});

	it("adds a new note on Notes page", () => {
		cy.get("nav").within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.contains("button", "Add Note").click();
		cy.contains("h3", "Note 3").should("be.visible");
		cy.contains("New note content").should("be.visible");
	});

	it("navigates back to Home page", () => {
		cy.get("nav").within(() => {
			cy.contains("a", "About").click();
		});
		cy.url().should("include", "/about");
		cy.get("nav").within(() => {
			cy.contains("a", "Home").click();
		});
		cy.url().should("eq", `${Cypress.config().baseUrl}/`);
		cy.contains("h1", "Paith Notes").should("be.visible");
		cy.get("nav").within(() => {
			cy.contains("a", "Home").should("have.class", "active");
		});
	});

	it("maintains route state on navigation between pages", () => {
		// Start on Home
		cy.url().should("eq", `${Cypress.config().baseUrl}/`);

		// Go to About
		cy.get("nav").within(() => {
			cy.contains("a", "About").click();
		});
		cy.url().should("include", "/about");
		cy.contains("h1", "About Paith Notes").should("be.visible");

		// Go to Notes
		cy.get("nav").within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.url().should("include", `/nooks/${CYPRESS_NOOK_ID}`);
		cy.contains("h1", "My Notes").should("be.visible");

		// Go back to Home
		cy.get("nav").within(() => {
			cy.contains("a", "Home").click();
		});
		cy.url().should("eq", `${Cypress.config().baseUrl}/`);
		cy.contains("h1", "Paith Notes").should("be.visible");
	});
});
