import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The window and query the fixtures were captured with. URLs are built from
 * it so the timestamps inside the responses fall inside the range the page
 * asks for — otherwise every chart would be drawn off its own axis.
 */
export const meta = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('fixtures/meta.json', import.meta.url)),
    'utf8',
  ),
) as {
  tenant: string;
  service: string;
  profileType: string;
  query: string;
  window: { start: number; end: number };
  left: { start: number; end: number };
  right: { start: number; end: number };
};

/** A URL pinned to the captured window, with the tenant already chosen. */
export function url(
  path: string,
  extra: Record<string, string | number> = {},
): string {
  const params = new URLSearchParams({
    tenant: meta.tenant,
    query: meta.query,
    from: String(meta.window.start),
    until: String(meta.window.end),
  });
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, String(value));
  }
  return `${path}?${params}`;
}

/**
 * Fails the test if the page logged an uncaught error at any point. Call once
 * at the top of a spec file; it registers its own hooks.
 *
 * Collected and asserted afterwards rather than thrown from the listener: a
 * throw inside the listener escapes the test's promise chain, so an error
 * arriving after the last `await` — a late canvas repaint, React's error path
 * during the closing navigation — is dropped and the test still reports green.
 */
export function watchPageErrors(): void {
  const seen: string[] = [];
  test.beforeEach(({ page }) => {
    seen.length = 0;
    page.on('pageerror', (error) => seen.push(error.message));
  });
  test.afterEach(() => {
    expect(seen, 'the page logged an uncaught error').toEqual([]);
  });
}

export interface UpstreamCall {
  method: string;
  tenant: string | null;
  groupBy: string[] | null;
  profileTypeID: string | null;
  labelSelector: string | null;
  start: number | null;
  end: number | null;
  step: number | null;
  name: string | null;
  limit: number | null;
}

/** What the fake upstream has been asked for, through the Go proxy. */
export async function upstreamLog(page: Page): Promise<UpstreamCall[]> {
  const res = await page.request.get('http://127.0.0.1:4142/__log');
  return res.json();
}

export async function clearUpstreamLog(page: Page): Promise<void> {
  await page.request.delete('http://127.0.0.1:4142/__log');
}

/**
 * Asserts a canvas actually had something drawn on it. jsdom cannot run these
 * transforms at all, so this is the only place a broken one is caught.
 */
export async function expectCanvasPainted(canvas: Locator): Promise<void> {
  await expect(canvas).toBeVisible();
  await expect
    .poll(
      () =>
        canvas.evaluate((el: HTMLCanvasElement) => {
          const ctx = el.getContext('2d');
          if (!ctx || el.width === 0 || el.height === 0) return 0;
          const { data } = ctx.getImageData(0, 0, el.width, el.height);
          const first = [data[0], data[1], data[2], data[3]].join();
          let different = 0;
          for (let i = 4; i < data.length; i += 4) {
            const px = [data[i], data[i + 1], data[i + 2], data[i + 3]].join();
            if (px !== first) different++;
          }
          return different;
        }),
      { message: 'the canvas was never painted', timeout: 15_000 },
    )
    .toBeGreaterThan(100);
}
