import { Button } from "./Button";

describe("Button Component", () => {
	it("renders with default props", () => {
		cy.mount(<Button>Click me</Button>);
		cy.get("button").should("contain", "Click me");
		cy.get("button").should("have.attr", "type", "button");
	});

	it("renders with primary variant by default", () => {
		cy.mount(<Button>Primary</Button>);
		cy.get("button").should("have.attr", "data-variant", "primary");
	});

	it("renders with secondary variant", () => {
		cy.mount(<Button variant="secondary">Secondary</Button>);
		cy.get("button").should("have.attr", "data-variant", "secondary");
	});

	it("renders with danger variant", () => {
		cy.mount(<Button variant="danger">Danger</Button>);
		cy.get("button").should("have.attr", "data-variant", "danger");
	});

	it("renders with small size", () => {
		cy.mount(<Button size="small">Small</Button>);
		cy.get("button").should("have.attr", "data-size", "small");
	});

	it("renders with medium size by default", () => {
		cy.mount(<Button>Medium</Button>);
		cy.get("button").should("have.attr", "data-size", "medium");
	});

	it("renders with large size", () => {
		cy.mount(<Button size="large">Large</Button>);
		cy.get("button").should("have.attr", "data-size", "large");
	});

	it("handles click events", () => {
		const onClick = cy.stub().as("onClick");
		cy.mount(<Button onClick={onClick}>Click me</Button>);
		cy.get("button").click();
		cy.get("@onClick").should("have.been.calledOnce");
	});

	it("can be disabled", () => {
		cy.mount(<Button disabled>Disabled</Button>);
		cy.get("button").should("be.disabled");
	});

	it("accepts custom className", () => {
		cy.mount(<Button class="custom-class">Custom</Button>);
		cy.get("button").should("have.class", "custom-class");
	});

	it("passes through other button attributes", () => {
		cy.mount(
			<Button data-testid="custom-button" aria-label="Custom button">
				Test
			</Button>,
		);
		cy.get("button")
			.should("have.attr", "data-testid", "custom-button")
			.and("have.attr", "aria-label", "Custom button");
	});
});
