import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// ============================================================================
// Inline schema copies (mirroring the Zod schemas from each action file).
// These are kept in sync with the actual defineAction().schema declarations.
// ============================================================================

const createSprintSchema = z.object({
  projectId: z.string().min(1).describe('Owning project id'),
  name: z.string().min(1).describe('Sprint name'),
  goal: z.string().optional().describe('Sprint goal or theme'),
  branch: z.string().optional().describe('Git branch the sprint targets'),
  startDate: z.string().optional().describe('Sprint start date (ISO-8601)'),
  endDate: z.string().optional().describe('Sprint end date (ISO-8601)'),
});

const updateSprintSchema = z.object({
  id: z.string().min(1).describe('Sprint id'),
  name: z.string().min(1).optional().describe('New sprint name'),
  goal: z.string().optional().describe('New sprint goal'),
  status: z.string().optional().describe('New status (规划|进行中|已完成)'),
  branch: z.string().optional().describe('New git branch'),
  startDate: z.string().optional().describe('New start date (ISO-8601)'),
  endDate: z.string().optional().describe('New end date (ISO-8601)'),
});

const triggerStageSchema = z.object({
  workItemId: z.string().min(1).describe('Work item to trigger a stage on'),
  stageName: z.string().min(1).describe('Stage name (e.g. 分析, 设计, 实施, 测试, 验收, 交付)'),
});

const rollbackStageSchema = z.object({
  workItemId: z.string().min(1).describe('Work item to rollback'),
  targetStage: z.string().min(1).describe('Target stage name to rollback to'),
  reason: z.string().optional().describe('Reason for the rollback'),
});

const createArtifactSchema = z.object({
  workItemId: z.string().min(1),
  stageId: z.string().min(1),
  stageName: z.string().min(1),
  kind: z.string().min(1).describe('e.g. 分析报告 / 设计稿 / 代码变更 / 测试集 / 验收报告'),
  name: z.string().min(1),
  contentRef: z.string().optional(),
  producedByKind: z.enum(['agent', 'human']).optional(),
});

const addCommentSchema = z.object({
  workItemId: z.string().min(1),
  body: z.string().min(1),
  authorName: z.string().optional(),
});

const addLinkSchema = z.object({
  fromItemId: z.string().min(1).describe('Source work item id'),
  toItemId: z.string().min(1).describe('Target work item id'),
  linkType: z.string().min(1).describe('Link type, e.g. depends-on, blocks, relates-to'),
});

const enqueueWorkItemSchema = z.object({
  workItemId: z.string().min(1).describe('Work item id to enqueue'),
  priority: z.coerce.number().int().optional().describe('Queue priority (default 0)'),
});

// F3 (T-F3-07): currentStageName REMOVED from this schema and `.strict()`
// added — every stage/status change must go through the guarded
// transition-work-item action or the evidence-backed advance-stage writeback
// channel; update-work-item is metadata-only now, and any attempt to smuggle
// currentStageName through it is a schema-level rejection (unrecognized key),
// not a silently-stripped no-op.
const updateWorkItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    type: z.string().optional(),
    priority: z.number().int().optional(),
    risk: z.string().optional(),
    tags: z.array(z.string()).optional(),
    executionMode: z.string().optional(),
    sprintId: z.string().nullable().optional(),
    plannedStages: z.array(z.string()).optional(),
    branch: z.string().nullable().optional(),
    owner: z.string().nullable().optional(),
    nature: z.array(z.string()).optional(),
  })
  .strict();

// Mirrors create-work-item.ts's schema.type enum (M1-6: adds "from-audit").
const createWorkItemSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  type: z
    .enum([
      "需求",
      "任务",
      "缺陷",
      "测试",
      "生产问题",
      "集合",
      "from-audit",
      "requirement",
      "task",
      "defect",
      "incident",
      "story",
      "epic",
    ])
    .optional(),
  priority: z.coerce.number().int().optional(),
  risk: z.enum(["low", "medium", "high"]).optional(),
  tags: z.array(z.string()).optional(),
  nature: z.array(z.string()).optional(),
  owner: z.string().nullable().optional(),
  sprintId: z.string().optional(),
  executionMode: z.enum(["auto", "manual"]).optional(),
});

// Mirrors advance-stage.ts's schema (M1-6).
const advanceStageSchema = z.object({
  scope: z.enum(["item", "sprint"]),
  id: z.string().min(1),
  fromStage: z.string().min(1),
  expectedRunId: z.string().optional(),
});

const listOrgMembersSchema = z.object({});

// ============================================================================
// STAGE_ORDER constant (from shared/types.ts)
// ============================================================================

const STAGE_ORDER = ['待办', '分析', '设计', '实施', '测试', '验收', '交付'] as const;

// ============================================================================
// TrackerWorkItem type structure (compile-time check)
// ============================================================================

type TrackerWorkItem = {
  id: string;
  projectId: string;
  sprintId: string | null;
  itemKey: string;
  type: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  risk: string;
  tags: string[];
  executionMode: string;
  currentStageName: string;
  plannedStages: string[];
  branch: string | null;
  orchestratorThreadId: string | null;
  createdAt: string;
  updatedAt: string;
};

// ============================================================================
// Tests for createSprintSchema
// ============================================================================

describe('create-sprint schema', () => {
  it('validates valid input with required fields', () => {
    const result = createSprintSchema.safeParse({ projectId: 'p1', name: 'Sprint 1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('p1');
      expect(result.data.name).toBe('Sprint 1');
    }
  });

  it('validates valid input with all optional fields', () => {
    const result = createSprintSchema.safeParse({
      projectId: 'p1',
      name: 'S1',
      goal: 'Ship feature X',
      branch: 'feature/x',
      startDate: '2026-01-01',
      endDate: '2026-01-14',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.goal).toBe('Ship feature X');
      expect(result.data.branch).toBe('feature/x');
      expect(result.data.startDate).toBe('2026-01-01');
      expect(result.data.endDate).toBe('2026-01-14');
    }
  });

  it('rejects missing projectId', () => {
    const result = createSprintSchema.safeParse({ name: 'Sprint 1' });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = createSprintSchema.safeParse({ projectId: 'p1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty projectId', () => {
    const result = createSprintSchema.safeParse({ projectId: '', name: 'Sprint 1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = createSprintSchema.safeParse({ projectId: 'p1', name: '' });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields individually', () => {
    const goalOnly = createSprintSchema.safeParse({ projectId: 'p1', name: 'S1', goal: 'Goal' });
    expect(goalOnly.success).toBe(true);

    const branchOnly = createSprintSchema.safeParse({ projectId: 'p1', name: 'S1', branch: 'main' });
    expect(branchOnly.success).toBe(true);

    const datesOnly = createSprintSchema.safeParse({
      projectId: 'p1',
      name: 'S1',
      startDate: '2026-01-01',
      endDate: '2026-01-14',
    });
    expect(datesOnly.success).toBe(true);
  });

  it('accepts empty string optional fields (min(1) does not apply to optional)', () => {
    const result = createSprintSchema.safeParse({
      projectId: 'p1',
      name: 'S1',
      goal: '',
      branch: '',
      startDate: '',
      endDate: '',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for updateSprintSchema
// ============================================================================

describe('update-sprint schema', () => {
  it('validates valid input with only the id', () => {
    const result = updateSprintSchema.safeParse({ id: 's1' });
    expect(result.success).toBe(true);
  });

  it('validates valid input with all optional fields', () => {
    const result = updateSprintSchema.safeParse({
      id: 's1',
      name: 'New Name',
      goal: 'New goal',
      status: '进行中',
      branch: 'develop',
      startDate: '2026-02-01',
      endDate: '2026-02-14',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const result = updateSprintSchema.safeParse({ name: 'Updated' });
    expect(result.success).toBe(false);
  });

  it('rejects empty id', () => {
    const result = updateSprintSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects empty name when explicitly provided (min(1) applies to optional)', () => {
    const result = updateSprintSchema.safeParse({ id: 's1', name: '' });
    expect(result.success).toBe(false);
  });

  it('accepts partial updates with just one field', () => {
    const justName = updateSprintSchema.safeParse({ id: 's1', name: 'Renamed' });
    expect(justName.success).toBe(true);

    const justStatus = updateSprintSchema.safeParse({ id: 's1', status: '已完成' });
    expect(justStatus.success).toBe(true);

    const justBranch = updateSprintSchema.safeParse({ id: 's1', branch: 'hotfix' });
    expect(justBranch.success).toBe(true);
  });

  it('does not reject extra fields (Zod default is passthrough)', () => {
    const result = updateSprintSchema.safeParse({
      id: 's1',
      name: 'N',
      extraField: 'should pass',
    });
    expect(result.success).toBe(true);
  });

  it('accepts non-ascii Chinese status value', () => {
    const result = updateSprintSchema.safeParse({
      id: 's1',
      status: '已发布',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for triggerStageSchema
// ============================================================================

describe('trigger-stage schema', () => {
  it('validates valid input with required fields', () => {
    const result = triggerStageSchema.safeParse({
      workItemId: 'wi1',
      stageName: '分析',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing workItemId', () => {
    const result = triggerStageSchema.safeParse({ stageName: '分析' });
    expect(result.success).toBe(false);
  });

  it('rejects missing stageName', () => {
    const result = triggerStageSchema.safeParse({ workItemId: 'wi1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty workItemId', () => {
    const result = triggerStageSchema.safeParse({ workItemId: '', stageName: '分析' });
    expect(result.success).toBe(false);
  });

  it('rejects empty stageName', () => {
    const result = triggerStageSchema.safeParse({ workItemId: 'wi1', stageName: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string workItemId', () => {
    const result = triggerStageSchema.safeParse({ workItemId: 123, stageName: '分析' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string stageName', () => {
    const result = triggerStageSchema.safeParse({ workItemId: 'wi1', stageName: 123 });
    expect(result.success).toBe(false);
  });

  it('accepts all valid stage names from STAGE_ORDER', () => {
    for (const stage of STAGE_ORDER) {
      const result = triggerStageSchema.safeParse({
        workItemId: 'wi1',
        stageName: stage,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ============================================================================
// Tests for rollbackStageSchema
// ============================================================================

describe('rollback-stage schema', () => {
  it('validates valid input with required fields', () => {
    const result = rollbackStageSchema.safeParse({
      workItemId: 'wi1',
      targetStage: '设计',
    });
    expect(result.success).toBe(true);
  });

  it('validates valid input with reason', () => {
    const result = rollbackStageSchema.safeParse({
      workItemId: 'wi1',
      targetStage: '分析',
      reason: '设计有问题需要重新分析',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing workItemId', () => {
    const result = rollbackStageSchema.safeParse({ targetStage: '设计' });
    expect(result.success).toBe(false);
  });

  it('rejects missing targetStage', () => {
    const result = rollbackStageSchema.safeParse({ workItemId: 'wi1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty workItemId', () => {
    const result = rollbackStageSchema.safeParse({ workItemId: '', targetStage: '设计' });
    expect(result.success).toBe(false);
  });

  it('rejects empty targetStage', () => {
    const result = rollbackStageSchema.safeParse({ workItemId: 'wi1', targetStage: '' });
    expect(result.success).toBe(false);
  });

  it('accepts empty reason (optional, no min)', () => {
    const result = rollbackStageSchema.safeParse({
      workItemId: 'wi1',
      targetStage: '设计',
      reason: '',
    });
    expect(result.success).toBe(true);
  });

  it('accepts reason omitted entirely', () => {
    const result = rollbackStageSchema.safeParse({
      workItemId: 'wi1',
      targetStage: '设计',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for createArtifactSchema
// ============================================================================

describe('create-artifact schema', () => {
  it('validates valid input with required fields', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'Requirements analysis',
    });
    expect(result.success).toBe(true);
  });

  it('validates valid input with all optional fields', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'Requirements analysis',
      contentRef: 's3://bucket/key',
      producedByKind: 'agent',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing workItemId', () => {
    const result = createArtifactSchema.safeParse({
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing stageId', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing stageName', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      kind: '分析报告',
      name: 'name',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing kind', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      name: 'name',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing name', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
    });
    expect(result.success).toBe(false);
  });

  it('validates producedByKind enum ("agent")', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
      producedByKind: 'agent',
    });
    expect(result.success).toBe(true);
  });

  it('validates producedByKind enum ("human")', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
      producedByKind: 'human',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid producedByKind value', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
      producedByKind: 'robot' as any,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty workItemId', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: '',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
    });
    expect(result.success).toBe(false);
  });

  it('accepts producedByKind omitted', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
    });
    expect(result.success).toBe(true);
  });

  it('accepts contentRef omitted', () => {
    const result = createArtifactSchema.safeParse({
      workItemId: 'wi1',
      stageId: 'stage1',
      stageName: '分析',
      kind: '分析报告',
      name: 'name',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for addCommentSchema
// ============================================================================

describe('add-comment schema', () => {
  it('validates valid input with required fields', () => {
    const result = addCommentSchema.safeParse({
      workItemId: 'wi1',
      body: 'This looks great!',
    });
    expect(result.success).toBe(true);
  });

  it('validates valid input with authorName', () => {
    const result = addCommentSchema.safeParse({
      workItemId: 'wi1',
      body: 'Comment text',
      authorName: 'Alice',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing workItemId', () => {
    const result = addCommentSchema.safeParse({ body: 'Some comment' });
    expect(result.success).toBe(false);
  });

  it('rejects missing body', () => {
    const result = addCommentSchema.safeParse({ workItemId: 'wi1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty workItemId', () => {
    const result = addCommentSchema.safeParse({ workItemId: '', body: 'text' });
    expect(result.success).toBe(false);
  });

  it('rejects empty body', () => {
    const result = addCommentSchema.safeParse({ workItemId: 'wi1', body: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string workItemId', () => {
    const result = addCommentSchema.safeParse({ workItemId: 123, body: 'text' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string body', () => {
    const result = addCommentSchema.safeParse({ workItemId: 'wi1', body: 123 });
    expect(result.success).toBe(false);
  });

  it('accepts single character body (min(1))', () => {
    const result = addCommentSchema.safeParse({ workItemId: 'wi1', body: 'x' });
    expect(result.success).toBe(true);
  });

  it('accepts multi-line body', () => {
    const result = addCommentSchema.safeParse({
      workItemId: 'wi1',
      body: 'Line 1\nLine 2\nLine 3',
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for addLinkSchema
// ============================================================================

describe('add-link schema', () => {
  it('validates valid input with required fields', () => {
    const result = addLinkSchema.safeParse({
      fromItemId: 'wi1',
      toItemId: 'wi2',
      linkType: 'depends-on',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing fromItemId', () => {
    const result = addLinkSchema.safeParse({ toItemId: 'wi2', linkType: 'depends-on' });
    expect(result.success).toBe(false);
  });

  it('rejects missing toItemId', () => {
    const result = addLinkSchema.safeParse({ fromItemId: 'wi1', linkType: 'depends-on' });
    expect(result.success).toBe(false);
  });

  it('rejects missing linkType', () => {
    const result = addLinkSchema.safeParse({ fromItemId: 'wi1', toItemId: 'wi2' });
    expect(result.success).toBe(false);
  });

  it('rejects empty fromItemId', () => {
    const result = addLinkSchema.safeParse({ fromItemId: '', toItemId: 'wi2', linkType: 'depends-on' });
    expect(result.success).toBe(false);
  });

  it('rejects empty toItemId', () => {
    const result = addLinkSchema.safeParse({ fromItemId: 'wi1', toItemId: '', linkType: 'depends-on' });
    expect(result.success).toBe(false);
  });

  it('rejects empty linkType', () => {
    const result = addLinkSchema.safeParse({ fromItemId: 'wi1', toItemId: 'wi2', linkType: '' });
    expect(result.success).toBe(false);
  });

  it('validates various link types', () => {
    const types = ['depends-on', 'blocks', 'relates-to', 'duplicates', 'implemented-by'];
    for (const lt of types) {
      const result = addLinkSchema.safeParse({
        fromItemId: 'wi1',
        toItemId: 'wi2',
        linkType: lt,
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts fromItemId same as toItemId (schema allows it, business logic may reject)', () => {
    const result = addLinkSchema.safeParse({
      fromItemId: 'wi1',
      toItemId: 'wi1',
      linkType: 'relates-to',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-string fromItemId', () => {
    const result = addLinkSchema.safeParse({ fromItemId: 123, toItemId: 'wi2', linkType: 'depends-on' });
    expect(result.success).toBe(false);
  });

  it('rejects non-string linkType', () => {
    const result = addLinkSchema.safeParse({ fromItemId: 'wi1', toItemId: 'wi2', linkType: 123 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Tests for enqueueWorkItemSchema
// ============================================================================

describe('enqueue-work-item schema', () => {
  it('validates valid input with only workItemId', () => {
    const result = enqueueWorkItemSchema.safeParse({ workItemId: 'wi1' });
    expect(result.success).toBe(true);
  });

  it('validates valid input with positive priority', () => {
    const result = enqueueWorkItemSchema.safeParse({
      workItemId: 'wi1',
      priority: 5,
    });
    expect(result.success).toBe(true);
  });

  it('validates negative priority', () => {
    const result = enqueueWorkItemSchema.safeParse({
      workItemId: 'wi1',
      priority: -3,
    });
    expect(result.success).toBe(true);
  });

  it('validates priority 0', () => {
    const result = enqueueWorkItemSchema.safeParse({
      workItemId: 'wi1',
      priority: 0,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing workItemId', () => {
    const result = enqueueWorkItemSchema.safeParse({ priority: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects empty workItemId', () => {
    const result = enqueueWorkItemSchema.safeParse({ workItemId: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer priority (float)', () => {
    const result = enqueueWorkItemSchema.safeParse({
      workItemId: 'wi1',
      priority: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-numeric priority', () => {
    const result = enqueueWorkItemSchema.safeParse({
      workItemId: 'wi1',
      priority: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('accepts priority as string via coerce', () => {
    const result = enqueueWorkItemSchema.safeParse({
      workItemId: 'wi1',
      priority: '5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe(5);
    }
  });

  it('rejects non-string workItemId', () => {
    const result = enqueueWorkItemSchema.safeParse({ workItemId: 123 });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Tests for updateWorkItemSchema
// ============================================================================

describe('update-work-item schema', () => {
  it('validates valid input with only the id', () => {
    const result = updateWorkItemSchema.safeParse({ id: 'wi1' });
    expect(result.success).toBe(true);
  });

  it('validates valid input with all fields', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      title: 'New title',
      description: 'Updated description',
      type: 'task',
      priority: 3,
      risk: 'medium',
      tags: ['frontend', 'urgent'],
      executionMode: 'auto',
      sprintId: null,
      plannedStages: ['分析', '设计'],
      branch: 'feature/x',
      owner: 'alice@example.com',
      nature: ['后端'],
    });
    expect(result.success).toBe(true);
  });

  // T-F3-07: update-work-item 拒 currentStageName — the旁路(bypass) that let
  // stage advancement skip the F3 guard entirely must be schema-rejected, not
  // silently accepted/stripped.
  it('F3/T-F3-07: rejects currentStageName as an unrecognized key', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      currentStageName: '实施',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.code === 'unrecognized_keys'),
      ).toBe(true);
    }
  });

  it('F3/T-F3-07: rejects currentStageName even alongside other valid fields', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      title: 'Sneaky stage bump',
      currentStageName: 'done' as any,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing id', () => {
    const result = updateWorkItemSchema.safeParse({ title: 'No id' });
    expect(result.success).toBe(false);
  });

  it('rejects empty id', () => {
    const result = updateWorkItemSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer priority', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      priority: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects string priority', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      priority: 'high',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null sprintId', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      sprintId: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts string sprintId', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      sprintId: 'sp1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-null-non-string sprintId', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      sprintId: 123 as any,
    });
    expect(result.success).toBe(false);
  });

  it('accepts null branch', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      branch: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty tags array', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      tags: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts populated tags array', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      tags: ['tag1', 'tag2', 'tag3'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects tags with non-string items', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      tags: ['valid', 123 as any],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty plannedStages array', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      plannedStages: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts populated plannedStages array', () => {
    const result = updateWorkItemSchema.safeParse({
      id: 'wi1',
      plannedStages: ['分析', '设计', '实施'],
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for create-work-item schema (M1-6: from-audit type)
// ============================================================================

describe('create-work-item schema', () => {
  it('validates valid input with only required fields', () => {
    const result = createWorkItemSchema.safeParse({ projectId: 'p1', title: 'A task' });
    expect(result.success).toBe(true);
  });

  it('rejects missing projectId', () => {
    const result = createWorkItemSchema.safeParse({ title: 'A task' });
    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = createWorkItemSchema.safeParse({ projectId: 'p1' });
    expect(result.success).toBe(false);
  });

  it('accepts all Chinese type values', () => {
    for (const type of ['需求', '任务', '缺陷', '测试', '生产问题', '集合']) {
      const result = createWorkItemSchema.safeParse({ projectId: 'p1', title: 't', type });
      expect(result.success).toBe(true);
    }
  });

  it('accepts "from-audit" as a real type value (not just a tag)', () => {
    const result = createWorkItemSchema.safeParse({
      projectId: 'p1',
      title: 't',
      type: 'from-audit',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized type value', () => {
    const result = createWorkItemSchema.safeParse({
      projectId: 'p1',
      title: 't',
      type: 'not-a-real-type',
    });
    expect(result.success).toBe(false);
  });

  it('accepts legacy English type aliases', () => {
    for (const type of ['requirement', 'task', 'defect', 'incident', 'story', 'epic']) {
      const result = createWorkItemSchema.safeParse({ projectId: 'p1', title: 't', type });
      expect(result.success).toBe(true);
    }
  });

  it('accepts null owner (unassigned)', () => {
    const result = createWorkItemSchema.safeParse({ projectId: 'p1', title: 't', owner: null });
    expect(result.success).toBe(true);
  });

  it('coerces string priority to number', () => {
    const result = createWorkItemSchema.safeParse({ projectId: 'p1', title: 't', priority: '1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe(1);
    }
  });
});

// ============================================================================
// Tests for advance-stage schema (M1-6)
// ============================================================================

describe('advance-stage schema', () => {
  it('validates valid item-scope input', () => {
    const result = advanceStageSchema.safeParse({
      scope: 'item',
      id: 'wi1',
      fromStage: '分析',
    });
    expect(result.success).toBe(true);
  });

  it('validates valid sprint-scope input', () => {
    const result = advanceStageSchema.safeParse({
      scope: 'sprint',
      id: 'sp1',
      fromStage: '实施',
      expectedRunId: 'run_123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid scope value', () => {
    const result = advanceStageSchema.safeParse({
      scope: 'epic',
      id: 'wi1',
      fromStage: '分析',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing scope', () => {
    const result = advanceStageSchema.safeParse({ id: 'wi1', fromStage: '分析' });
    expect(result.success).toBe(false);
  });

  it('rejects missing id', () => {
    const result = advanceStageSchema.safeParse({ scope: 'item', fromStage: '分析' });
    expect(result.success).toBe(false);
  });

  it('rejects missing fromStage', () => {
    const result = advanceStageSchema.safeParse({ scope: 'item', id: 'wi1' });
    expect(result.success).toBe(false);
  });

  it('rejects empty id and empty fromStage', () => {
    expect(advanceStageSchema.safeParse({ scope: 'item', id: '', fromStage: '分析' }).success).toBe(false);
    expect(advanceStageSchema.safeParse({ scope: 'item', id: 'wi1', fromStage: '' }).success).toBe(false);
  });

  it('accepts expectedRunId omitted', () => {
    const result = advanceStageSchema.safeParse({ scope: 'item', id: 'wi1', fromStage: '分析' });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Tests for STAGE_ORDER constant
// ============================================================================

describe('STAGE_ORDER constant', () => {
  it('has exactly 7 stages', () => {
    expect(STAGE_ORDER.length).toBe(7);
  });

  it('has correct first stage (待办)', () => {
    expect(STAGE_ORDER[0]).toBe('待办');
  });

  it('has correct second stage (分析)', () => {
    expect(STAGE_ORDER[1]).toBe('分析');
  });

  it('has correct third stage (设计)', () => {
    expect(STAGE_ORDER[2]).toBe('设计');
  });

  it('has correct fourth stage (实施)', () => {
    expect(STAGE_ORDER[3]).toBe('实施');
  });

  it('has correct fifth stage (测试)', () => {
    expect(STAGE_ORDER[4]).toBe('测试');
  });

  it('has correct sixth stage (验收)', () => {
    expect(STAGE_ORDER[5]).toBe('验收');
  });

  it('has correct seventh stage (交付)', () => {
    expect(STAGE_ORDER[6]).toBe('交付');
  });

  it('has no duplicate stages', () => {
    const unique = new Set(STAGE_ORDER);
    expect(unique.size).toBe(STAGE_ORDER.length);
  });

  it('all elements are strings', () => {
    for (const stage of STAGE_ORDER) {
      expect(typeof stage).toBe('string');
    }
  });
});

// ============================================================================
// Tests for TrackerWorkItem type structure (compile-time)
// ============================================================================

describe('TrackerWorkItem type structure', () => {
  it('accepts a valid TrackerWorkItem object at compile time', () => {
    const item: TrackerWorkItem = {
      id: 'wi1',
      projectId: 'p1',
      sprintId: null,
      itemKey: 'WI-1',
      type: 'task',
      title: 'Test task',
      description: 'A test task',
      status: 'open',
      priority: 1,
      risk: 'low',
      tags: ['test'],
      executionMode: 'auto',
      currentStageName: '待办',
      plannedStages: ['待办', '分析', '设计'],
      branch: null,
      orchestratorThreadId: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(item.id).toBe('wi1');
    expect(item.type).toBe('task');
    expect(item.status).toBe('open');
    expect(item.sprintId).toBeNull();
    expect(item.tags).toEqual(['test']);
    expect(item.currentStageName).toBe('待办');
  });

  it('allows sprintId to be a string', () => {
    const item: TrackerWorkItem = {
      id: 'wi2',
      projectId: 'p1',
      sprintId: 'sp1',
      itemKey: 'WI-2',
      type: 'requirement',
      title: 'Another task',
      description: 'desc',
      status: 'running',
      priority: 5,
      risk: 'high',
      tags: [],
      executionMode: 'manual',
      currentStageName: '实施',
      plannedStages: [],
      branch: 'main',
      orchestratorThreadId: 'thread-1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    expect(item.sprintId).toBe('sp1');
    expect(item.branch).toBe('main');
    expect(item.orchestratorThreadId).toBe('thread-1');
  });

  it('has all expected fields', () => {
    const item: TrackerWorkItem = {
      id: '',
      projectId: '',
      sprintId: null,
      itemKey: '',
      type: '',
      title: '',
      description: '',
      status: '',
      priority: 0,
      risk: '',
      tags: [],
      executionMode: '',
      currentStageName: '',
      plannedStages: [],
      branch: null,
      orchestratorThreadId: null,
      createdAt: '',
      updatedAt: '',
    };
    const fields = Object.keys(item) as (keyof TrackerWorkItem)[];
    expect(fields).toContain('id');
    expect(fields).toContain('projectId');
    expect(fields).toContain('sprintId');
    expect(fields).toContain('itemKey');
    expect(fields).toContain('type');
    expect(fields).toContain('title');
    expect(fields).toContain('description');
    expect(fields).toContain('status');
    expect(fields).toContain('priority');
    expect(fields).toContain('risk');
    expect(fields).toContain('tags');
    expect(fields).toContain('executionMode');
    expect(fields).toContain('currentStageName');
    expect(fields).toContain('plannedStages');
    expect(fields).toContain('branch');
    expect(fields).toContain('orchestratorThreadId');
    expect(fields).toContain('createdAt');
    expect(fields).toContain('updatedAt');
  });
});

// ============================================================================
// Tests for listOrgMembersSchema
// ============================================================================

describe('list-org-members schema', () => {
  it('accepts an empty object (no required params)', () => {
    expect(() => listOrgMembersSchema.parse({})).not.toThrow();
  });
});
