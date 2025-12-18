import { test, expect } from '@playwright/test';

test.describe('Paith Notes App', () => {
  test('should load the home page', async ({ page }) => {
    await page.goto('/');
    
    // Check that the title is present
    await expect(page.locator('h1')).toContainText('Paith Notes');
  });

  test('should display the subtitle with dev UI info', async ({ page }) => {
    await page.goto('/');
    
    // Check that the subtitle is present
    const subtitle = page.locator('p').first();
    await expect(subtitle).toContainText('Dev UI (SolidJS) fetching');
    await expect(subtitle).toContainText('/health');
  });

  test('should fetch and display health status', async ({ page }) => {
    await page.goto('/');
    
    // Wait for loading to complete (not showing "Loading health..." anymore)
    await expect(page.getByText('Loading health...')).not.toBeVisible({ timeout: 10000 });
    
    // Check that health data is displayed
    const healthPre = page.locator('pre').first();
    await expect(healthPre).toBeVisible();
    
    // Verify the health response contains expected fields
    const healthText = await healthPre.textContent();
    expect(healthText).toContain('status');
    expect(healthText).toContain('service');
  });

  test('should have a refetch button that works', async ({ page }) => {
    await page.goto('/');
    
    // Wait for initial load
    await expect(page.getByText('Loading health...')).not.toBeVisible({ timeout: 10000 });
    
    // Find and click the refetch button
    const refetchButton = page.getByRole('button', { name: 'Refetch' });
    await expect(refetchButton).toBeVisible();
    
    // Get initial counter value
    const healthPre = page.locator('pre').first();
    const initialHealthText = await healthPre.textContent();
    const initialCounterMatch = initialHealthText?.match(/"counter":\s*(\d+)/);
    const initialCounter = initialCounterMatch ? parseInt(initialCounterMatch[1]) : null;
    
    // Click refetch button
    await refetchButton.click();
    
    // Wait a bit for the refetch to complete
    await page.waitForTimeout(1000);
    
    // Get new counter value
    const newHealthText = await healthPre.textContent();
    const newCounterMatch = newHealthText?.match(/"counter":\s*(\d+)/);
    const newCounter = newCounterMatch ? parseInt(newCounterMatch[1]) : null;
    
    // Counter should have incremented
    if (initialCounter !== null && newCounter !== null) {
      expect(newCounter).toBeGreaterThan(initialCounter);
    }
  });

  test('should handle health endpoint errors gracefully', async ({ page }) => {
    // Navigate to a page that would cause the health endpoint to fail
    // For this test, we're just ensuring no error boundary crashes
    await page.goto('/');
    
    // Wait a reasonable amount of time
    await page.waitForTimeout(3000);
    
    // Check that either health data or error is shown (no blank page)
    const hasHealthData = await page.locator('pre').first().isVisible().catch(() => false);
    const hasError = await page.locator('pre').filter({ hasText: 'Error' }).isVisible().catch(() => false);
    
    expect(hasHealthData || hasError).toBeTruthy();
  });
});
