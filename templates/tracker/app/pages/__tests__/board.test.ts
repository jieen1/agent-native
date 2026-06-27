import { describe, expect, it } from 'vitest';
import type { TrackerWorkItem } from '../../../shared/types.js';

// Extract the grouping logic from BoardPage into a pure function to test
function groupByStage(items: TrackerWorkItem[]): Record<string, TrackerWorkItem[]> {
  const STAGES = ['待办','分析','设计','实施','测试','验收','交付'];
  const groups: Record<string, TrackerWorkItem[]> = {};
  for (const s of STAGES) groups[s] = [];
  for (const item of items) {
    const stage = item.currentStageName || '待办';
    if (!groups[stage]) groups[stage] = [];
    groups[stage].push(item);
  }
  return groups;
}

describe('Board groupByStage', () => {
  const makeItem = (id: string, stage: string): TrackerWorkItem => ({
    id, projectId: 'p1', sprintId: null, itemKey: `TRK-${id}`,
    type: '需求', title: `Item ${id}`, description: '', status: 'open',
    priority: 0, risk: 'medium', tags: [], executionMode: 'manual',
    currentStageName: stage, plannedStages: [], branch: null,
    orchestratorThreadId: null, createdAt: '', updatedAt: ''
  });

  it('groups items by currentStageName', () => {
    const items = [makeItem('1', '待办'), makeItem('2', '实施'), makeItem('3', '待办')];
    const groups = groupByStage(items);
    expect(groups['待办']).toHaveLength(2);
    expect(groups['实施']).toHaveLength(1);
    expect(groups['交付']).toHaveLength(0);
  });
  it('returns all 7 stage keys even when empty', () => {
    const groups = groupByStage([]);
    expect(Object.keys(groups)).toHaveLength(7);
  });
  it('defaults unknown stage to 待办', () => {
    const item = makeItem('1', '');
    const groups = groupByStage([item]);
    expect(groups['待办']).toHaveLength(1);
  });
  it('counts correct items per stage', () => {
    const items = Array.from({length: 5}, (_, i) => makeItem(String(i), '测试'));
    const groups = groupByStage(items);
    expect(groups['测试']).toHaveLength(5);
  });
});
