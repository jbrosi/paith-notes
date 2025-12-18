import { test, expect } from '@playwright/test';

/**
 * Component tests for the Button component
 * These tests verify the Button component works correctly in the app
 */

test.describe('Button Component', () => {
  test.beforeEach(async ({ page, context }) => {
    // Mock the /health endpoint
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
    // Wait for page to load
    await page.waitForLoadState('networkidle');
  });

  test('should render button with text', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Refetch' });
    await expect(button).toBeVisible();
    await expect(button).toContainText('Refetch');
  });

  test('should be clickable and enabled by default', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Refetch' });
    await expect(button).toBeEnabled();
    
    // Should be able to click
    await button.click();
    // If it clicked successfully, the button should still be visible
    await expect(button).toBeVisible();
  });

  test('should have button styling applied', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Refetch' });
    
    // Check that the button has CSS applied (computed color should not be default)
    const backgroundColor = await button.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });
    
    // Should have a background color set (not transparent or default)
    expect(backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(backgroundColor).not.toBe('transparent');
  });

  test('should respond to click events', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Refetch' });
    
    // Wait for page to be ready
    await expect(page.getByText('Loading health...')).not.toBeVisible({ timeout: 5000 });
    
    // Button should be clickable
    await expect(button).toBeEnabled();
    
    // Click the button
    await button.click();
    
    // Button should still be visible and enabled after click
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
  });

  test('should have proper button HTML attributes', async ({ page }) => {
    const button = page.getByRole('button', { name: 'Refetch' });
    
    // Check it's a button element
    const tagName = await button.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe('button');
    
    // Check type attribute (should be button by default)
    const buttonType = await button.getAttribute('type');
    expect(buttonType).toBe('button');
  });
});
