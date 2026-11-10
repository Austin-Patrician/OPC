import type { TFunction } from 'i18next';

/**
 * 本体里的谓词和实体类型是给机器看的名字（`has_task`、`Worker`）。
 * 界面上必须说人话，否则用户只会看到一串下划线标识符。
 *
 * 已知谓词查表；没见过的谓词去掉下划线原样显示，至少不再是 `snake_case`。
 */

const PREDICATE_KEYS: Record<string, string> = {
  prefers: 'settings.memory.predicate.prefers',
  has_goal: 'settings.memory.predicate.hasGoal',
  works_on: 'settings.memory.predicate.worksOn',
  decided: 'settings.memory.predicate.decided',
  knows_person: 'settings.memory.predicate.knowsPerson',
  uses_tool: 'settings.memory.predicate.usesTool',
  committed_to: 'settings.memory.predicate.committedTo',
  describes: 'settings.memory.predicate.describes',
  has_task: 'settings.memory.predicate.hasTask',
  has_worker: 'settings.memory.predicate.hasWorker',
  assigned_to: 'settings.memory.predicate.assignedTo',
};

const ENTITY_TYPE_KEYS: Record<string, string> = {
  User: 'settings.memory.entityType.user',
  Project: 'settings.memory.entityType.project',
  Goal: 'settings.memory.entityType.goal',
  Task: 'settings.memory.entityType.task',
  Decision: 'settings.memory.entityType.decision',
  Preference: 'settings.memory.entityType.preference',
  Person: 'settings.memory.entityType.person',
  Tool: 'settings.memory.entityType.tool',
  Resource: 'settings.memory.entityType.resource',
  Commitment: 'settings.memory.entityType.commitment',
  Worker: 'settings.memory.entityType.worker',
  Router: 'settings.memory.entityType.router',
  Entity: 'settings.memory.entityType.entity',
};

export function predicateLabel(t: TFunction, predicate: string): string {
  const key = PREDICATE_KEYS[predicate];
  if (key) return t(key);
  return predicate.replace(/^legacy:/, '').replace(/_/g, ' ');
}

export function entityTypeLabel(t: TFunction, entityType: string): string {
  const key = ENTITY_TYPE_KEYS[entityType];
  return key ? t(key) : entityType;
}
