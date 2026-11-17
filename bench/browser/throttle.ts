// 4x CPU throttle so frame-time budgets are measured on a reproducible low-end target.
import type { Page } from '@playwright/test';

export async function throttle4x(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
