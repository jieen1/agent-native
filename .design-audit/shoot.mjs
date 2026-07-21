/**
 * UI 设计一致性审查 — 真实浏览器截图取证脚本（无副作用：只读打开页面并截图）。
 *
 * 用法:
 *   node .design-audit/shoot.mjs
 *   APP_URLS="orchestrator=http://localhost:3101,tracker=http://localhost:3102" node .design-audit/shoot.mjs
 *
 * 产出:
 *   .design-audit/screenshots/prototype-<screen>.<theme>.png  — 原型 HTML 对照证据
 *   .design-audit/screenshots/<app>-<page>.<theme>.png        — 应用页面证据
 *        （仅当 APP_URLS 环境变量给出应用地址时；失败会如实记录进 manifest，
 *        绝不伪造截图）
 *
 * 主题切换手段:
 *   - 原型 HTML: 与其自带主题按钮完全等效的 document.documentElement.classList.add('dark')
 *     （原型按钮即 onclick="document.documentElement.classList.toggle('dark')"）
 *   - 应用页面: 同样用 .dark class（next-themes attribute="class"，与框架
 *     ThemeProvider/⌘K 主题项的行为一致）
 *
 * 视口 1440x904 —— 与 docs/sdlc-product-design/prototypes/screenshots/ 下
 * baseline 截图的分辨率一致（PNG IHDR 实测 1440x904），保证并排可比。
 */
import { mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = realpathSync(resolve(HERE, "..")); // 解析 /work 软链到真实仓库根
const OUT = resolve(HERE, "screenshots");
mkdirSync(OUT, { recursive: true });

// pnpm 严格 node_modules 下根包不可见 playwright，直接走 .pnpm 实体路径
// （ESM 不支持目录导入，用 createRequire 解析出真实入口文件）。
const require_ = createRequire(import.meta.url);
const playwrightEntry = require_.resolve(
  resolve(REPO, "node_modules/.pnpm/playwright@1.61.1/node_modules/playwright"),
);
const pwMod = await import(pathToFileURL(playwrightEntry).href);
const pw = pwMod.default ?? pwMod;

const VIEWPORT = { width: 1440, height: 904 };
const manifest = [];

function record(entry) {
  manifest.push({ ...entry, capturedAt: new Date().toISOString() });
  console.log(
    `${entry.ok ? "OK  " : "FAIL"} ${entry.file ?? entry.name} ${entry.theme ?? ""} ${entry.note ?? ""}`,
  );
}

const PROTOTYPES = [
  { name: "s2-sprint-studio", file: "s2-sprint-studio.html" },
  { name: "s6-sprint-cockpit", file: "s6-sprint-cockpit.html" },
  { name: "s9-brain-console", file: "s9-brain-console.html" },
  { name: "s10-health-insights", file: "s10-health-insights.html" },
];

// 应用页面：由 APP_URLS="orchestrator=http://localhost:3101,tracker=http://localhost:3102"
// 传入。本审查运行环境中两个应用均因框架级 SSR 缺陷（见报告）返回 500，
// 脚本会把失败如实记录进 manifest，而不是伪造截图。
const APP_URLS = {};
for (const pair of (process.env.APP_URLS ?? "").split(",")) {
  const [app, url] = pair.split("=");
  if (app && url) APP_URLS[app.trim()] = url.trim();
}

const APP_PAGES = [
  { app: "orchestrator", page: "index", path: "/" },
  { app: "orchestrator", page: "brain", path: "/brain" },
  { app: "orchestrator", page: "health", path: "/health" },
  { app: "orchestrator", page: "insights", path: "/insights" },
  { app: "tracker", page: "sprints", path: "/sprints" },
];

const browser = await pw.chromium.launch({ headless: true });

async function shoot(url, theme, outName, kind) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    colorScheme: theme === "dark" ? "dark" : "light",
  });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    // 与页面自带机制等效的主题挂载
    if (theme === "dark") {
      await page.evaluate(() => document.documentElement.classList.add("dark"));
    } else {
      await page.evaluate(() =>
        document.documentElement.classList.remove("dark"),
      );
    }
    await page.waitForTimeout(600); // 等字体/动效稳定
    const out = resolve(OUT, outName);
    await page.screenshot({ path: out, fullPage: false });
    record({
      ok: true,
      kind,
      name: outName,
      file: outName,
      theme,
      url,
      httpStatus: resp?.status?.() ?? null,
    });
  } catch (err) {
    record({
      ok: false,
      kind,
      name: outName,
      theme,
      url,
      note: String(err).split("\n")[0],
    });
  } finally {
    await ctx.close();
  }
}

// ── 1) 原型 HTML 对照证据 ────────────────────────────────────────────────────
for (const p of PROTOTYPES) {
  const abs = resolve(REPO, "docs/sdlc-product-design/prototypes", p.file);
  if (!existsSync(abs)) {
    record({
      ok: false,
      kind: "prototype",
      name: p.name,
      note: "file missing",
    });
    continue;
  }
  const url = pathToFileURL(abs).href;
  await shoot(url, "light", `prototype-${p.name}.light.png`, "prototype");
  await shoot(url, "dark", `prototype-${p.name}.dark.png`, "prototype");
}

// ── 2) 应用页面证据（仅当提供了地址）─────────────────────────────────────────
for (const spec of APP_PAGES) {
  const base = APP_URLS[spec.app];
  if (!base) {
    record({
      ok: false,
      kind: "app",
      name: `${spec.app}-${spec.page}`,
      note: "no base url provided (app not started)",
    });
    continue;
  }
  const url = base.replace(/\/$/, "") + spec.path;
  await shoot(url, "light", `${spec.app}-${spec.page}.light.png`, "app");
  await shoot(url, "dark", `${spec.app}-${spec.page}.dark.png`, "app");
}

await browser.close();

writeFileSync(
  resolve(HERE, "screenshot-manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      viewport: VIEWPORT,
      tool: "playwright@1.61.1 (chromium headless)",
      themeMethod:
        "document.documentElement.classList.add('dark') — 与原型自带主题按钮及 next-themes class 策略等效",
      entries: manifest,
    },
    null,
    2,
  ),
);
console.log("\nmanifest written:", manifest.length, "entries");
