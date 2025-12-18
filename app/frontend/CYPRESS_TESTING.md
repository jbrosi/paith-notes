# Cypress Component Testing

This project uses Cypress for component testing with SolidJS.

## Button Component Demo

You can see the Button component in action by running the development server and visiting the demo page:

```bash
npm run dev
```

Then navigate to: `http://localhost:5173/?demo=button`

![Button Component Demo](https://github.com/user-attachments/assets/ab587d97-85cf-4323-b125-a196c9e63a1a)

## Setup

All dependencies are already installed. If you need to reinstall:

```bash
npm install
```

## Running Tests

### Interactive Mode (Cypress Test Runner)
Open the Cypress Test Runner to run tests interactively:

```bash
npm run test:component:open
```

### Headless Mode
Run tests in headless mode (useful for CI/CD):

```bash
npm run test:component
```

## Writing Tests

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
/// <reference types="../cypress" />
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

## Configuration

- `cypress.config.ts` - Main Cypress configuration
- `tsconfig.cypress.json` - TypeScript configuration for Cypress tests
- `cypress/support/component.ts` - Component testing setup
- `cypress.d.ts` - TypeScript definitions for custom commands

## Button Component Example

The Button component demonstrates a well-tested component with:
- Multiple variants (primary, secondary, danger)
- Multiple sizes (small, medium, large)
- Disabled state support
- Custom className support
- Full TypeScript support

See `src/components/Button.tsx` and `src/components/Button.cy.tsx` for implementation and tests.
