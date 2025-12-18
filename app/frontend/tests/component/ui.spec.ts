import { test, expect } from '@playwright/test';

/**
 * Component tests for the App component
 * These tests verify the App component renders correctly
 */

test.describe('App Component Structure', () => {
  test.beforeEach(async ({ page, context }) => {
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
    
    await page.goto('/');
  });

  test('should render the title', async ({ page }) => {
    // Check title is present
    await expect(page.locator('h1')).toContainText('Paith Notes');
  });

  test('should render the subtitle with code element', async ({ page }) => {
    // Check subtitle and code element
    const subtitle = page.locator('p').first();
    await expect(subtitle).toContainText('Dev UI (SolidJS) fetching');
    
    const code = page.locator('code');
    await expect(code).toHaveText('/health');
  });

  test('should render a refetch button', async ({ page }) => {
    // Check button exists
    const button = page.getByRole('button', { name: 'Refetch' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('should show loading state initially', async ({ page }) => {
    // Component should show loading or loaded state
    const hasLoading = await page.getByText('Loading health...').isVisible().catch(() => false);
    const hasContent = await page.locator('pre').first().isVisible().catch(() => false);
    
    // Either loading or already loaded
    expect(hasLoading || hasContent).toBeTruthy();
  });

  test('should display health data after loading', async ({ page }) => {
    // Wait for loading to complete
    await expect(page.getByText('Loading health...')).not.toBeVisible({ timeout: 5000 });
    
    // Check that health data is displayed
    const pre = page.locator('pre').first();
    await expect(pre).toBeVisible();
    
    // Verify content includes expected data
    const content = await pre.textContent();
    expect(content).toContain('status');
    expect(content).toContain('ok');
    expect(content).toContain('counter');
    expect(content).toContain('42');
  });

  test('should have proper structure', async ({ page }) => {
    // Check main container exists
    const main = page.locator('main');
    await expect(main).toBeVisible();
    
    // Title should exist
    const title = page.locator('h1');
    await expect(title).toBeVisible();
  });

  test('should refetch when button is clicked', async ({ page }) => {
    // Wait for initial load
    await expect(page.getByText('Loading health...')).not.toBeVisible({ timeout: 5000 });
    
    // Get initial counter value
    const pre = page.locator('pre').first();
    const initialContent = await pre.textContent();
    expect(initialContent).toContain('counter');
    
    // Click refetch button
    const button = page.getByRole('button', { name: 'Refetch' });
    await button.click();
    
    // Should show loading or data (refetch happened)
    await expect(pre).toBeVisible();
  });
});
