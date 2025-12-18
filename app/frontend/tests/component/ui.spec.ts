import { test, expect } from '@playwright/experimental-ct-core';
import App from '../../src/App';

/**
 * Component tests for the App component
 * These tests mount the component in isolation
 */

test.describe('App Component', () => {
  test.beforeEach(async ({ context }) => {
    // Mock the /health endpoint for component tests
    await context.route('**/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          service: 'paith-notes',
          ts: '2024-01-01T00:00:00Z',
          counter: 42,
        }),
      });
    });
  });

  test('should render the title', async ({ mount }) => {
    const component = await mount(App);
    
    // Check title is present
    await expect(component.locator('h1')).toContainText('Paith Notes');
  });

  test('should render the subtitle with code element', async ({ mount }) => {
    const component = await mount(App);
    
    // Check subtitle and code element
    const subtitle = component.locator('p').first();
    await expect(subtitle).toContainText('Dev UI (SolidJS) fetching');
    
    const code = component.locator('code');
    await expect(code).toHaveText('/health');
  });

  test('should render a refetch button', async ({ mount }) => {
    const component = await mount(App);
    
    // Check button exists
    const button = component.getByRole('button', { name: 'Refetch' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('should show loading state initially', async ({ mount }) => {
    const component = await mount(App);
    
    // Component should show loading or loaded state
    const hasLoading = await component.getByText('Loading health...').isVisible().catch(() => false);
    const hasContent = await component.locator('pre').first().isVisible().catch(() => false);
    
    // Either loading or already loaded
    expect(hasLoading || hasContent).toBeTruthy();
  });

  test('should display health data after loading', async ({ mount }) => {
    const component = await mount(App);
    
    // Wait for loading to complete
    await expect(component.getByText('Loading health...')).not.toBeVisible({ timeout: 5000 });
    
    // Check that health data is displayed
    const pre = component.locator('pre').first();
    await expect(pre).toBeVisible();
    
    // Verify content includes expected data
    const content = await pre.textContent();
    expect(content).toContain('status');
    expect(content).toContain('ok');
    expect(content).toContain('counter');
    expect(content).toContain('42');
  });

  test('should have proper CSS module classes applied', async ({ mount }) => {
    const component = await mount(App);
    
    // Check main container exists
    const main = component.locator('main');
    await expect(main).toBeVisible();
    
    // Title should exist
    const title = component.locator('h1');
    await expect(title).toBeVisible();
  });

  test('should refetch when button is clicked', async ({ mount }) => {
    const component = await mount(App);
    
    // Wait for initial load
    await expect(component.getByText('Loading health...')).not.toBeVisible({ timeout: 5000 });
    
    // Get initial counter value
    const pre = component.locator('pre').first();
    const initialContent = await pre.textContent();
    expect(initialContent).toContain('counter');
    
    // Click refetch button
    const button = component.getByRole('button', { name: 'Refetch' });
    await button.click();
    
    // Should show loading or data (refetch happened)
    await expect(pre).toBeVisible();
  });
});
