import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/** A58 U1, U2: layout checks every phone screen's tests share. */

/** The page never scrolls sideways. */
export async function noSidewaysScroll(page: Page): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);
}

/**
 * Every control on screen inside `scope` that is under 44 px either way:
 * buttons, selects, inputs and the values that become a field on a tap. A
 * radio or a checkbox is hit through its label, so the label is measured.
 */
export async function smallTargets(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) =>
    [
      ...root.querySelectorAll<HTMLElement>(
        'button, select, input, [role="button"], .editable-inline > .editable-text, .editable-labelled > .editable-text',
      ),
    ]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const hit =
          el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')
            ? (el.closest('label') ?? el)
            : el;
        return { el, r: hit.getBoundingClientRect() };
      })
      .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
      .map(
        ({ el, r }) =>
          `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      ),
  );
}
