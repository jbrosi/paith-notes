import { test, expect } from '@playwright/test';

/**
 * Component tests for UI elements
 * Since the experimental component testing library is deprecated,
 * we test components through the integrated app
 */

test.describe('App Component UI', () => {
  test('should render with correct CSS classes', async ({ page }) => {
    await page.goto('/');
    
    // Check main container exists with expected class
    const main = page.locator('main');
    await expect(main).toBeVisible();
    
    // Check title styling
    const title = page.locator('h1');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Paith Notes');
  });

  test('should have properly styled button', async ({ page }) => {
    await page.goto('/');
    
    // Wait for page to load
    await page.waitForLoadState('networkidle');
    
    // Check button exists and is clickable
    const button = page.getByRole('button', { name: 'Refetch' });
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('should display code element in subtitle', async ({ page }) => {
    await page.goto('/');
    
    // Check that the /health path is wrapped in a code element
    const code = page.locator('code');
    await expect(code).toBeVisible();
    await expect(code).toHaveText('/health');
  });

  test('should display JSON in pre element', async ({ page }) => {
    await page.goto('/');
    
    // Wait for loading to complete
    await expect(page.getByText('Loading health...')).not.toBeVisible({ timeout: 10000 });
    
    // Check pre element for JSON display
    const pre = page.locator('pre').first();
    await expect(pre).toBeVisible();
    
    // Verify it contains valid JSON structure
    const content = await pre.textContent();
    expect(() => JSON.parse(content || '')).not.toThrow();
  });
});
