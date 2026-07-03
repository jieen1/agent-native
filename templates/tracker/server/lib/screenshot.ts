import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CANDIDATE_CHROMIUM_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    const resolved = stdout.trim();
    return resolved && existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** Detect a locally installed Chromium/Chrome executable, checking common
 * PLAYWRIGHT/PUPPETEER env vars, well-known install paths, then `which`. */
async function localChromiumExecutablePath(): Promise<string | null> {
  const configured =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_BIN ||
    process.env.CHROMIUM_PATH;
  if (configured && existsSync(configured)) return configured;

  for (const candidate of CANDIDATE_CHROMIUM_PATHS) {
    if (existsSync(candidate)) return candidate;
  }

  for (const bin of [
    "chromium-browser",
    "google-chrome-stable",
    "chromium",
    "google-chrome",
  ]) {
    const found = await which(bin);
    if (found) return found;
  }
  return null;
}

export interface ScreenshotResult {
  png: Buffer;
  pageText: string;
}

/** Launch a headless Chromium (local install if found, else playwright-core's
 * own bundled browser), navigate to `url`, and capture a full-page PNG plus
 * the rendered body text (for optional substring assertions). Throws
 * `new Error("no browser available")` when no browser can be launched at all,
 * so callers can surface a clean, expected error instead of crashing. */
export async function captureScreenshot(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<ScreenshotResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let chromiumLauncher: typeof import("playwright-core").chromium;
  try {
    ({ chromium: chromiumLauncher } = await import("playwright-core"));
  } catch {
    throw new Error("no browser available");
  }

  const executablePath = await localChromiumExecutablePath();

  let browser: Awaited<ReturnType<typeof chromiumLauncher.launch>>;
  try {
    browser = await chromiumLauncher.launch(
      executablePath ? { headless: true, executablePath } : { headless: true },
    );
  } catch {
    throw new Error("no browser available");
  }

  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    page.setDefaultTimeout(timeoutMs);
    await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
    const pageText = (await page.textContent("body").catch(() => "")) ?? "";
    const pngBuffer = await page.screenshot({ type: "png" });
    return { png: Buffer.from(pngBuffer), pageText };
  } finally {
    await browser.close().catch(() => {});
  }
}