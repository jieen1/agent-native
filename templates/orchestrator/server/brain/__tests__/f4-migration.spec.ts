// F4 迁移与数据面存在性锁(docs/sdlc-impl-f1-f4.md §6.4 T-F4-07 的可单测半:
// 命名迁移 `f4-capability-matrix` 与两列 DDL、schema 声明、种子 brain 行必须
// 同时在位且互相一致;"真 Postgres 空库跑迁移断言列存在" 属靶位库集成)。
//
// fs 源码断言而非导入执行:runMigrations 的迁移数组是模块私有,导入插件
// 不暴露它;直接读源文件把 DDL 文本锁死,防止并行分支重排/误删。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const orchestratorRoot = join(__dirname, "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(orchestratorRoot, rel), "utf-8");
}

describe("T-F4-07 (unit) — 命名迁移 f4-capability-matrix 在位", () => {
  const dbPlugin = read("server/plugins/db.ts");

  it("carries the NAMED migration (防并行分支版本号碰撞)", () => {
    expect(dbPlugin).toContain('name: "f4-capability-matrix"');
  });

  it("adds BOTH agent-def columns additively (ADD COLUMN IF NOT EXISTS)", () => {
    expect(dbPlugin).toMatch(
      /ALTER TABLE orchestrator_agent_defs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'worker'/,
    );
    expect(dbPlugin).toMatch(
      /ALTER TABLE orchestrator_agent_defs ADD COLUMN IF NOT EXISTS capability_profile TEXT NOT NULL DEFAULT '\{\}'/,
    );
  });

  it("carries the NAMED brain_threads.phase migration (评审相位随线程持久)", () => {
    expect(dbPlugin).toContain('name: "f4-brain-thread-phase"');
    expect(dbPlugin).toMatch(
      /ALTER TABLE brain_threads ADD COLUMN IF NOT EXISTS phase text/,
    );
  });

  it("contains no destructive DDL in the F4 statements", () => {
    for (const kw of [
      "DROP COLUMN",
      "RENAME COLUMN",
      "DROP TABLE orchestrator_agent_defs",
    ]) {
      expect(dbPlugin).not.toContain(kw);
    }
  });
});

describe("schema 声明与迁移一致", () => {
  it("schema.ts declares kind + capabilityProfile on agentDefs", () => {
    const schema = read("server/db/schema.ts");
    expect(schema).toMatch(
      /kind: text\("kind"\).notNull\(\).default\("worker"\)/,
    );
    expect(schema).toMatch(
      /capabilityProfile: text\("capability_profile"\).notNull\(\).default\("\{\}"\)/,
    );
  });

  it("v3-schema.ts declares brainThreads.phase", () => {
    const v3schema = read("server/db/v3-schema.ts");
    expect(v3schema).toMatch(/phase: text\("phase"\)/);
  });
});

describe("种子 brain 行(kind=brain,双相位只读工具面)", () => {
  const seed = read("server/plugins/agent-defs-seed.ts");

  it("seeds a kind=brain row named 'brain'", () => {
    expect(seed).toContain('name: "brain"');
    expect(seed).toContain('kind: "brain"');
  });

  it("its capability profile carries dispatch+review faces without write tools", () => {
    const brainBlock = seed.slice(seed.indexOf('name: "brain"'));
    expect(brainBlock).toContain("dispatch:");
    expect(brainBlock).toContain("review:");
    expect(brainBlock).toContain('"mcp__orchestrator"');
    // The brain profile's tool arrays must not include write tools.
    const profileMatch = brainBlock.match(
      /capabilityProfile: \{[\s\S]*?\n    \},/,
    );
    expect(profileMatch).not.toBeNull();
    for (const forbidden of ['"Bash"', '"Write"', '"Edit"']) {
      expect(profileMatch![0]).not.toContain(forbidden);
    }
  });

  it("persists kind + capabilityProfile in the seed insert", () => {
    expect(seed).toContain("kind: def.kind");
    expect(seed).toMatch(
      /capabilityProfile: JSON.stringify\(def.capabilityProfile \?\? \{\}\)/,
    );
  });
});

describe("list-agent-defs 默认排除 brain 行(WorkflowEditor 选不到)", () => {
  it("filters kind=worker unless includeBrain:true", () => {
    const action = read("actions/list-agent-defs.ts");
    expect(action).toContain("includeBrain");
    expect(action).toMatch(/eq\(schema.agentDefs.kind, "worker"\)/);
  });
});
