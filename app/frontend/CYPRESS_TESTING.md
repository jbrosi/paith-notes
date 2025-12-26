# Cypress Testing

This project uses Cypress for both component testing and end-to-end (e2e) testing with SolidJS.

## Component Testing

### Viewing Components (Like Storybook)

Cypress component tests work similarly to Storybook! When you open the interactive test runner, you can view and interact with components in isolation:

```bash
sh scripts/run-frontend-e2e-open.sh
```

This opens a browser UI where you can:
- See all component tests
- Click on any test to view the component rendered in isolation
- Interact with the component in real-time
- See test assertions pass/fail

Each test in a component's `.cy.tsx` file acts as a different "story" showing various states and configurations of the component.

## Setup

All dependencies are installed inside containers (no local Yarn/NPM required).

## Running Tests

### Component Tests

#### Interactive Mode (Cypress Test Runner)
Open the Cypress Test Runner to run component tests interactively:

```bash
sh scripts/run-frontend-e2e-open.sh
```

#### Headless Mode
Run component tests in headless mode (useful for CI/CD):

```bash
sh scripts/run-frontend-component-tests.sh
```

### E2E Tests

#### Interactive Mode (Cypress Test Runner)
Open the Cypress Test Runner to run e2e tests interactively:

```bash
sh scripts/run-frontend-e2e-open.sh
```

#### Headless Mode
Run e2e tests in headless mode (useful for CI/CD):

```bash
sh scripts/run-frontend-e2e-tests.sh
```

**Note:** E2E tests target the monorepo entrypoint served by the `app` container at `http://localhost:8000`.

## Cleanup

If you want to stop the stack and remove volumes:

```bash
docker compose down -v
```

## Writing Tests

### Component Tests

Component tests are located alongside the components they test with the `.cy.tsx` extension.

### Example Structure

```
src/
  components/
    Button.tsx              # Component
    Button.module.css       # Component styles
    Button.cy.tsx          # Component test
```

### Example Test

```tsx
import { Button } from "./Button";

describe("Button Component", () => {
  it("renders with default props", () => {
    cy.mount(<Button>Click me</Button>);
    cy.get("button").should("contain", "Click me");
  });

  it("handles click events", () => {
    const onClick = cy.stub().as("onClick");
    cy.mount(<Button onClick={onClick}>Click me</Button>);
    cy.get("button").click();
    cy.get("@onClick").should("have.been.calledOnce");
  });
});
```

### E2E Tests

E2E tests are located in the `cypress/e2e/` directory with the `.cy.ts` or `.cy.tsx` extension.

#### Example Structure

```
cypress/
  e2e/
    app.cy.ts              # E2E test for the App
  support/
    e2e.ts                 # E2E testing setup
    commands.ts            # Custom Cypress commands
```

#### Example E2E Test

```tsx
describe("App E2E", () => {
  beforeEach(() => {
    cy.visit("/");
  });

  it("displays the app title", () => {
    cy.get("h1").should("contain", "Paith Notes");
  });

  it("fetches and displays health data", () => {
    cy.get("pre").should("exist");
    cy.get("pre").should("contain", "status");
  });

  it("has a working refetch button", () => {
    cy.contains("button", "Refetch").click();
  });
});
```

## Configuration

- `cypress.config.ts` - Main Cypress configuration (includes both component and e2e configs)
- `tsconfig.cypress.json` - TypeScript configuration for Cypress tests
- `cypress/support/component.ts` - Component testing setup
- `cypress/support/e2e.ts` - E2E testing setup
- `cypress.d.ts` - TypeScript definitions for custom commands

## Button Component Example

The Button component demonstrates a well-tested component with:
- Multiple variants (primary, secondary, danger)
- Multiple sizes (small, medium, large)
- Disabled state support
- Custom className support
- Full TypeScript support

See `src/components/Button.tsx` and `src/components/Button.cy.tsx` for implementation and tests.
