import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./app"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  test: {
    // The existing *.spec.ts files in this template are standalone tsx scripts
    // that call process.exit() directly — they predate vitest and run via tsx.
    // Exclude them so vitest does not attempt to execute them as test suites.
    // Remove this exclude entry when those files are migrated to proper vitest tests.
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "shared/types.public-settings.spec.ts",
      "server/lib/submission-validation.spec.ts",
    ],
    passWithNoTests: true,
    // `pnpm test:fast` runs every template's suite concurrently on one
    // resource-constrained CI runner. Many tests here do real dynamic
    // imports plus several sequencer/DB round-trips per assertion, so the
    // vitest default (5000ms) is too tight under that load and intermittently
    // times out one test, whose forced abort then corrupts the isolated
    // SQLite temp file for whichever test runs next in the same worker
    // (SDLC-038 investigation, PR#22). Raising the default gives real
    // headroom without masking a genuinely slow/hanging test (20s is still
    // well short of the CI job's own timeout).
    testTimeout: 20000,
    // 关键隔离配置 / critical isolation config (work item 2twmcsp7qo):
    // (1) packages/core 的 getDb()/getDbExec() 是 process-level 单例,
    //     只在第一次调用时读取一次 process.env.DATABASE_URL 并缓存连接。
    // (2) 多个 tracker 测试文件 (item-key-dedupe / item-key-sequencer /
    //     db-migration 等) 在 beforeAll 里把 DATABASE_URL 指向 mkdtempSync
    //     生成的临时 SQLite 文件 —— 这个约定只有在"每个测试文件独占一个
    //     vitest worker 进程"时才安全。
    // (3) 若不关闭文件级并行,vitest 4.x 会把多个测试文件塞进同一个 worker:
    //     后加载文件的 beforeAll 改 DATABASE_URL 对已初始化的单例无效,
    //     多个文件静默共享同一个物理 SQLite 文件;某个文件 afterEach 里
    //     无 scope 的 `DELETE FROM` (如 item-key-dedupe 清空 tracker_work_items)
    //     会把同 worker 里另一个文件正在使用的数据 wipe 掉
    //     (SDLC-038 / PR#19 CI regression: decompose-epic & create-work-item
    //     超时 + 读到空字符串的断言失败)。
    // (4) fileParallelism: false 强制所有测试文件在单个 worker 里串行执行,
    //     每个文件独占进程;每个文件已有的 afterAll closeDbExec() 会重置单例,
    //     下一个文件首次 getDbExec() 时重新读取自己的 DATABASE_URL,
    //     拿到自己的临时 SQLite 文件,从而确定性地消除跨文件数据 wipe。
    fileParallelism: false,
  },
});
