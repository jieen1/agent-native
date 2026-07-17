import { describe, expect, it } from "vitest";

import {
  buildDependencyGraph,
  computeWaves,
  extractSection,
  parseApiTable,
  parseFileMatrix,
  parseTechDesignItems,
} from "../tech-design-parse.js";

const SAMPLE_DOC = `# Sprint 技术设计

## §1 概览

本 sprint 交付队列重排序与超时提醒。

## §2 约定

统一使用 itemKey 作为跨文档锚点。

## §3 架构

三层：actions -> server/lib -> schema。

## §4 工作项设计

### §4.1 PRJ-001 · 队列重排序

- **依赖**: 无

实现拖拽排序持久化到 exec_queue.position。

### §4.2 PRJ-002 · 超时提醒

- **依赖**: PRJ-001

读取 PRJ-001 暴露的排序 API 计算预计等待时间。

### §4.3 PRJ-003 · 通知渠道

- **依赖**: PRJ-002, PRJ-999

发送提醒（PRJ-999 尚未在本设计中拆出独立小节，属缺失项）。

## §5 数据模型

exec_queue 增加 position 列。

## §6 API 表

| 方法 | 路径 | 生产方 | 消费方 | 说明 |
| --- | --- | --- | --- | --- |
| GET | /api/queue/eta | PRJ-001 | PRJ-002 | 返回预计等待时间 |

## §7 文件变更矩阵

| 文件路径 | 操作 | 所属工作项 | 说明 | 依赖文件 |
| --- | --- | --- | --- | --- |
| \`actions/reorder-queue.ts\` | MODIFY | PRJ-001 | 持久化顺序 | |
| \`actions/get-queue-eta.ts\` | CREATE | PRJ-002 | 读取排序计算 ETA | \`actions/reorder-queue.ts\` |

## §8 测试策略

黑盒场景覆盖见 test-plan。

### Env Vars

- \`QUEUE_ETA_TTL_MS\`: 缓存 TTL

## §9 自审

路径与 §7 一致，已核对。
`;

describe("extractSection", () => {
  it("extracts a §N section's body up to the next ## heading", () => {
    const s3 = extractSection(SAMPLE_DOC, 3);
    expect(s3).not.toBeNull();
    expect(s3!).toContain("三层");
    expect(s3!).not.toContain("§4 工作项设计");
  });

  it("returns null when the section heading is absent", () => {
    expect(extractSection(SAMPLE_DOC, 42)).toBeNull();
  });

  it("captures a nested ### subsection (Env Vars) within §8", () => {
    const s8 = extractSection(SAMPLE_DOC, 8);
    expect(s8).toContain("Env Vars");
    expect(s8).toContain("QUEUE_ETA_TTL_MS");
  });
});

describe("parseTechDesignItems", () => {
  it("parses every §4.N item with itemKey, title, body and declared deps", () => {
    const items = parseTechDesignItems(SAMPLE_DOC);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      itemKey: "PRJ-001",
      title: "队列重排序",
      dependsOn: [],
    });
    expect(items[1]).toMatchObject({
      itemKey: "PRJ-002",
      title: "超时提醒",
      dependsOn: ["PRJ-001"],
    });
    expect(items[2]!.dependsOn).toEqual(["PRJ-002", "PRJ-999"]);
    expect(items[0]!.body).toContain("exec_queue.position");
  });

  it("returns an empty array when §4 is absent", () => {
    expect(parseTechDesignItems("# doc\n\n## §1 概览\n\nx\n")).toEqual([]);
  });
});

describe("parseFileMatrix", () => {
  it("parses all 5 columns per row", () => {
    const rows = parseFileMatrix(SAMPLE_DOC);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      path: "actions/reorder-queue.ts",
      operation: "MODIFY",
      itemKey: "PRJ-001",
    });
    expect(rows[1]!.dependsOnFiles).toEqual(["actions/reorder-queue.ts"]);
  });
});

describe("parseApiTable", () => {
  it("parses producer/consumer columns", () => {
    const rows = parseApiTable(SAMPLE_DOC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ producer: "PRJ-001", consumer: "PRJ-002" });
  });
});

describe("buildDependencyGraph", () => {
  it("merges declared deps, API-table producer→consumer, and file-matrix deps without duplicates", () => {
    const items = parseTechDesignItems(SAMPLE_DOC);
    const apiRows = parseApiTable(SAMPLE_DOC);
    const fileRows = parseFileMatrix(SAMPLE_DOC);
    const edges = buildDependencyGraph(items, apiRows, fileRows);

    // PRJ-002 depends on PRJ-001 via BOTH declared §4 text AND the API table
    // AND the file-matrix 依赖文件 reference — must collapse to one edge.
    const prj002ToPrj001 = edges.filter(
      (e) => e.itemKey === "PRJ-002" && e.dependsOn === "PRJ-001",
    );
    expect(prj002ToPrj001).toHaveLength(1);

    const prj003Edges = edges.filter((e) => e.itemKey === "PRJ-003");
    expect(prj003Edges.map((e) => e.dependsOn).sort()).toEqual([
      "PRJ-002",
      "PRJ-999",
    ]);
  });

  it("ignores self-referential or empty edges", () => {
    const items = [
      { itemKey: "A", title: "t", body: "", dependsOn: ["A", ""] },
    ];
    const edges = buildDependencyGraph(items, [], []);
    expect(edges).toEqual([]);
  });
});

describe("computeWaves", () => {
  it("layers independent items into the same wave and respects dependency order", () => {
    const { waves, cycleEdges, missingItems } = computeWaves(
      ["PRJ-001", "PRJ-002", "PRJ-003"],
      [
        { itemKey: "PRJ-002", dependsOn: "PRJ-001", source: "declared" },
        { itemKey: "PRJ-003", dependsOn: "PRJ-002", source: "declared" },
        { itemKey: "PRJ-003", dependsOn: "PRJ-999", source: "declared" },
      ],
    );
    expect(cycleEdges).toEqual([]);
    expect(waves).toEqual([["PRJ-001"], ["PRJ-002"], ["PRJ-003"]]);
    expect(missingItems).toEqual(["PRJ-999"]);
  });

  it("puts independent items with no deps in the same first wave", () => {
    const { waves } = computeWaves(
      ["A", "B", "C"],
      [{ itemKey: "C", dependsOn: "A", source: "declared" }],
    );
    expect(waves[0]!.sort()).toEqual(["A", "B"]);
    expect(waves[1]).toEqual(["C"]);
  });

  it("detects a cycle and reports its edges instead of infinite-looping", () => {
    const { waves, cycleEdges } = computeWaves(
      ["A", "B"],
      [
        { itemKey: "A", dependsOn: "B", source: "declared" },
        { itemKey: "B", dependsOn: "A", source: "declared" },
      ],
    );
    expect(waves).toEqual([]);
    expect(cycleEdges).toHaveLength(2);
  });

  it("handles a diamond dependency without duplicating waves", () => {
    // A -> B, A -> C, B -> D, C -> D
    const { waves } = computeWaves(
      ["A", "B", "C", "D"],
      [
        { itemKey: "B", dependsOn: "A", source: "declared" },
        { itemKey: "C", dependsOn: "A", source: "declared" },
        { itemKey: "D", dependsOn: "B", source: "declared" },
        { itemKey: "D", dependsOn: "C", source: "declared" },
      ],
    );
    expect(waves).toEqual([["A"], ["B", "C"], ["D"]]);
  });
});
