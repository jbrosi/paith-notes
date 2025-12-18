/// <reference types="cypress" />

import { mount } from "cypress/solid";

declare global {
	namespace Cypress {
		interface Chainable {
			mount: typeof mount;
		}
	}
}
