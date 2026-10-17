/** What the worker wait uses of a browser Puppeteer launched. */
export interface LaunchedBrowser {
  waitForTarget(predicate: (target: never) => unknown, options: { timeout: number }): Promise<unknown>;
  version(): Promise<string>;
  process(): { spawnfile: string; spawnargs: string[] } | null;
  newPage(): Promise<{
    goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
    evaluate(fn: () => unknown): Promise<unknown>;
    close(): Promise<unknown>;
  }>;
  close(): Promise<unknown>;
}

export function waitForExtensionWorker<T>(
  browser: LaunchedBrowser,
  isWorker: (target: T) => boolean | Promise<boolean>,
  options: { timeout: number },
): Promise<T>;

export function explainMissingWorker(browser: LaunchedBrowser, options: { timeout: number }): Promise<string>;
