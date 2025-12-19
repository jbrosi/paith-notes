describe("Paith Notes App E2E", () => {
	beforeEach(() => {
		cy.visit("/");
	});

	it("displays the app title and subtitle", () => {
		cy.get("h1").should("contain", "Paith Notes");
		cy.contains("Dev UI (SolidJS) fetching");
		cy.contains("/health");
	});

	it("fetches and displays health data on load", () => {
		// Wait for loading to complete
		cy.contains("Loading health...").should("not.exist");

		// Check that health data is displayed
		cy.get("pre").should("exist");
		cy.get("pre").should("contain", "status");
		cy.get("pre").should("contain", "service");
		cy.get("pre").should("contain", "ts");
		cy.get("pre").should("contain", "counter");
	});

	it("has a refetch button that fetches health data", () => {
		// Wait for initial load
		cy.contains("Loading health...").should("not.exist");

		// Get the initial counter value
		cy.get("pre")
			.invoke("text")
			.then((initialText) => {
				const initialData = JSON.parse(initialText);
				const initialCounter = initialData.counter;

				// Click the refetch button
				cy.contains("button", "Refetch").click();

				// Wait a bit for the refetch
				cy.wait(100);

				// Verify the counter has changed (incremented)
				cy.get("pre")
					.invoke("text")
					.then((newText) => {
						const newData = JSON.parse(newText);
						expect(newData.counter).to.be.greaterThan(initialCounter);
					});
			});
	});

	it("displays the Button component with correct styling", () => {
		cy.contains("button", "Refetch").should("be.visible");
		cy.contains("button", "Refetch").should("have.class", "button");
		cy.contains("button", "Refetch").should("have.class", "primary");
		cy.contains("button", "Refetch").should("have.class", "medium");
	});

	it("button is clickable and not disabled", () => {
		cy.contains("button", "Refetch").should("not.be.disabled");
		cy.contains("button", "Refetch").should("have.attr", "type", "button");
	});
});
