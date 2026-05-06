describe("Routing E2E Tests", () => {
	const headers = {
		"X-Nook-User": "11111111-1111-4111-8111-111111111111",
		"X-Nook-Groups": "paith/notes",
	};

	const nav = () => cy.get("nav").filter(":visible").first();

	const getFirstNookId = () => {
		return cy
			.request({ method: "GET", url: "/api/nooks", headers })
			.its("body")
			.then((body) => {
				expect(body).to.have.property("nooks");
				expect(body.nooks).to.have.length.greaterThan(0);
				return String(body.nooks[0].id);
			});
	};

	beforeEach(() => {
		cy.request({ method: "GET", url: "/api/me", headers });
		cy.visit("/");
	});

	it("displays navigation with all route links", () => {
		nav().should("exist");
		nav().within(() => {
			cy.get("a").should("have.length", 3);
			cy.contains("a", "Home").should("have.attr", "href", "/");
			cy.contains("a", "About").should("have.attr", "href", "/about");
			cy.contains("a", "Notes").should("have.attr", "href", "/nooks");
		});
	});

	it("highlights active route in navigation", () => {
		// Home should be active by default
		nav().within(() => {
			cy.contains("a", "Home").should("have.class", "active");
			cy.contains("a", "About").should("not.have.class", "active");
			cy.contains("a", "Notes").should("not.have.class", "active");
		});
	});

	it("navigates to About page", () => {
		nav().within(() => {
			cy.contains("a", "About").click();
		});
		cy.url().should("include", "/about");
		cy.contains("h1", "About Paith Notes").should("be.visible");
		cy.contains("A simple note-taking application").should("be.visible");
		nav().within(() => {
			cy.contains("a", "About").should("have.class", "active");
		});
	});

	it("navigates to Notes page", () => {
		nav().within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.url().should("match", /\/nooks\/[0-9a-f-]{36}$/i);
		cy.contains("h2", "My Notes").should("be.visible");
		nav().within(() => {
			cy.contains("a", "Notes").should("have.class", "active");
		});
	});

	it("displays notes from the API on Notes page", () => {
		getFirstNookId().then((nookId) => {
			cy.request({
				method: "POST",
				url: `/api/nooks/${nookId}/notes`,
				headers,
				body: { title: "First Note", content: "This is my first note" },
			});
			cy.request({
				method: "POST",
				url: `/api/nooks/${nookId}/notes`,
				headers,
				body: { title: "Second Note", content: "This is my second note" },
			});
		});

		nav().within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.contains("button", "First Note").should("be.visible");
		cy.contains("button", "Second Note").should("be.visible");
	});

	it("creates a new note via the UI", () => {
		const title = `E2E Note ${Date.now()}`;

		nav().within(() => {
			cy.contains("a", "Notes").click();
		});

		cy.contains("button", "New").click();
		cy.get('input[type="text"]').clear().type(title);
		cy.contains("button", "Save").click();

		cy.contains("button", title, { timeout: 10_000 }).should("be.visible");
	});

	it("shows outgoing and incoming mentions", () => {
		const label = `Mention ${Date.now()}`;

		getFirstNookId().then((nookId) => {
			cy.request({
				method: "POST",
				url: `/api/nooks/${nookId}/notes`,
				headers,
				body: { title: "Source Note", content: "" },
			}).then((res) => {
				const sourceId = String(res.body?.note?.id ?? "");
				expect(sourceId).to.not.equal("");

				cy.request({
					method: "POST",
					url: `/api/nooks/${nookId}/notes`,
					headers,
					body: { title: "Target Note", content: "" },
				}).then((res2) => {
					const targetId = String(res2.body?.note?.id ?? "");
					expect(targetId).to.not.equal("");

					cy.request({
						method: "PUT",
						url: `/api/nooks/${nookId}/notes/${sourceId}`,
						headers,
						body: {
							title: "Source Note",
							content: `See [${label}](note:${targetId})`,
						},
					});
				});
			});
		});

		nav().within(() => {
			cy.contains("a", "Notes").click();
		});

		cy.contains("button", "Source Note").click();
		cy.contains("Mentions").should("be.visible");
		cy.contains("Outgoing").should("be.visible");
		cy.contains("Incoming").should("be.visible");
		cy.contains("button", label).should("be.visible");

		cy.contains("button", label).click();
		cy.get('input[type="text"]').should("have.value", "Target Note");
		cy.contains("Mentions").should("be.visible");
		cy.contains("Incoming").should("be.visible");
		cy.contains("button", "Source Note").should("be.visible");
	});

	it("navigates back to Home page", () => {
		nav().within(() => {
			cy.contains("a", "About").click();
		});
		cy.url().should("include", "/about");
		nav().within(() => {
			cy.contains("a", "Home").click();
		});
		cy.url().should("eq", `${Cypress.config().baseUrl}/`);
		cy.contains("h1", "Paith Notes").should("be.visible");
		nav().within(() => {
			cy.contains("a", "Home").should("have.class", "active");
		});
	});

	it("maintains route state on navigation between pages", () => {
		// Start on Home
		cy.url().should("eq", `${Cypress.config().baseUrl}/`);

		// Go to About
		nav().within(() => {
			cy.contains("a", "About").click();
		});
		cy.url().should("include", "/about");
		cy.contains("h1", "About Paith Notes").should("be.visible");

		// Go to Notes
		nav().within(() => {
			cy.contains("a", "Notes").click();
		});
		cy.url().should("match", /\/nooks\/[0-9a-f-]{36}$/i);
		cy.contains("h2", "My Notes").should("be.visible");

		// Go back to Home
		nav().within(() => {
			cy.contains("a", "Home").click();
		});
		cy.url().should("eq", `${Cypress.config().baseUrl}/`);
		cy.contains("h1", "Paith Notes").should("be.visible");
	});
});
