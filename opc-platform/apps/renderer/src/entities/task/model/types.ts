/** Domain contracts live in @opc/shared so main and renderer cannot drift. */
export type {
  TaskAcceptance,
  TaskArtifact,
  TaskEvidence,
  TaskStatus,
  TaskStep,
  WorkTask,
} from '@opc/shared/domain';
