import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
const require = createRequire(import.meta.url);
const pw = require("/workspaces/8852f710-e7f5-4584-89dc-6a622c325283/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.js");

const PREFIX = "/orchestrator/_agent-native/actions";
const OUT = "/workspaces/8852f710-e7f5-4584-89dc-6a622c325283/templates/tracker/.review-screenshots";
const SIGNIN_PATH = "/orchestrator/_agent-native/sign-in?return=%2F";
await mkdir(OUT, { recursive: true });

const log = (...a) => console.log("[capture]", ...a);

// ── 0. Wait until the dev server answers — discover which port serves the app ──
const CANDIDATE_PORTS = [9302, 3002, 8100, 8080, 5173, 3000];
let BASE = null;
outer: for (let i = 0; i < 40; i++) {
  for (const port of CANDIDATE_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${SIGNIN_PATH}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 200) { BASE = `http://127.0.0.1:${port}`; break outer; }
      log(`probe ${i} port ${port}: status ${r.status}`);
    } catch (e) {
      if (i % 4 === 0) log(`probe ${i} port ${port}: ${e.cause?.code ?? e.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 8000));
}
if (!BASE) throw new Error("dev server never became ready on any candidate port");
const SIGNIN = BASE + SIGNIN_PATH;
log("server is up at", BASE);

// ── 0b. Wait until action routes are mounted (db-status stops 404ing) ──
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${BASE}${PREFIX}/db-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(8000),
    });
    if (r.status !== 404) { log("actions mounted (db-status ->", r.status + ")"); break; }
    if (i % 5 === 0) log(`actions not mounted yet (probe ${i})`);
  } catch (e) {
    if (i % 5 === 0) log(`db-status probe ${i}: ${e.cause?.code ?? e.message}`);
  }
  await new Promise((r) => setTimeout(r, 4000));
}

const browser = await pw.chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// ── 1. Sign up a fresh account ──
const email = `review-r5-${Date.now()}@local.test`;
const password = "ReviewR5!pass123";
await page.goto(SIGNIN, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(800);
await page.locator("#s-email").fill(email);
await page.locator("#s-pass").fill(password);
await page.locator("#s-pass2").fill(password);
await page.locator("button[type=submit]").first().click();
await page.waitForTimeout(4000);
log("after signup url:", page.url());
if (page.url().includes("sign-in")) throw new Error("signup did not land in app");

// ── 2. Seed data via action HTTP endpoints (browser request context carries cookies) ──
const req = ctx.request;
async function call(name, body) {
  const res = await req.post(`${BASE}${PREFIX}/${name}`, { data: body });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  log(`[${name}] ${res.status()}`, text.slice(0, 160));
  if (!res.ok()) throw new Error(`${name} failed: ${res.status()} ${text.slice(0, 200)}`);
  return json;
}
const unwrap = (o) => (o && typeof o === "object" && o.data !== undefined ? o.data : o);

const project = unwrap(await call("create-project", {
  name: "结算中心重构", key: "PAY",
  description: "结算中心 v2 重构项目",
  gitRemote: "https://github.com/acme/pay-core.git", defaultBranch: "main",
}));
const projectId = project.id;
log("projectId:", projectId);

const item = unwrap(await call("create-work-item", {
  projectId,
  title: "对账单导出支持多币种与分页",
  description:
    "背景：当前对账单导出只支持单币种，大批量导出会超时。\n\n需求：\n1. 导出接口支持按币种分组，输出多 sheet Excel；\n2. 导出任务改为后台异步执行，完成后站内信通知；\n3. 单次导出上限 10 万行，超出时自动分片；\n4. 保留旧版同步导出入口一个版本做灰度。\n\n验收：在 staging 环境用 12 万行数据验证分片导出，耗时 < 90s，文件可正常打开。",
  type: "需求", priority: 2, risk: "medium",
  tags: ["对账", "导出"], nature: ["后端", "API"],
  owner: "agent", executionMode: "manual",
}));
const itemId = item.id;
log("itemId:", itemId, "itemKey:", item.itemKey);

const item2 = unwrap(await call("create-work-item", {
  projectId,
  title: "导出任务增加审计日志",
  description: "为所有后台导出任务补充审计日志，记录操作人、时间、行数与文件指纹。",
  type: "任务", priority: 3, risk: "low", tags: ["审计"], nature: ["后端"],
}));
const item2Id = item2.id;
log("item2Id:", item2Id);

await call("add-comment", {
  workItemId: itemId,
  body: "和财务确认过：多币种导出优先支持 USD/CNY/EUR 三种，其他币种下个迭代再排。灰度期间旧入口保留，但默认引导到新入口。",
});
await call("add-link", { fromItemId: itemId, toItemId: item2Id, linkType: "relates-to" });

// ── 3. Open the detail page and capture light + dark ──
const detailUrl = `${BASE}/items/${itemId}`;
log("detail url:", detailUrl);
await page.goto(detailUrl, { waitUntil: "networkidle", timeout: 120000 });
await page.waitForTimeout(3500);
log("detail landed:", page.url(), "title:", await page.title());

const gridInfo = await page.evaluate(() => {
  const grids = Array.from(document.querySelectorAll("div.grid"));
  const three = grids.find((g) => (g.className || "").includes("240px"));
  if (!three) return { found: false };
  const cs = getComputedStyle(three);
  return {
    found: true,
    cols: cs.gridTemplateColumns,
    childCount: three.children.length,
    childOrders: Array.from(three.children).map((c) => getComputedStyle(c).order),
  };
});
log("grid:", JSON.stringify(gridInfo));

await page.screenshot({ path: `${OUT}/light.png`, fullPage: true });
log("saved light.png");

await page.evaluate(() => {
  document.documentElement.classList.add("dark");
  document.documentElement.classList.remove("light");
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/dark.png`, fullPage: true });
log("saved dark.png");

const colors = await page.evaluate(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const pick = (n) => cs.getPropertyValue(n).trim();
  const grids = Array.from(document.querySelectorAll("div.grid"));
  const three = grids.find((g) => (g.className || "").includes("240px"));
  let panelBg = null, cardBg = null;
  if (three) {
    const rail = three.children[0];
    const panelEl = rail?.querySelector(".bg-panel") ?? rail;
    if (panelEl) panelBg = getComputedStyle(panelEl).backgroundColor;
    const card = three.querySelector('[class*="bg-card"]');
    if (card) cardBg = getComputedStyle(card).backgroundColor;
  }
  return { panelToken: pick("--panel"), background: pick("--background"), cardToken: pick("--card"), panelBg, cardBg, isDark: root.classList.contains("dark") };
});
log("dark colors:", JSON.stringify(colors));

await browser.close();
console.log("CAPTURE_DONE itemId=" + itemId);
