import type { ChatContentBlock } from '@opc/shared/domain';

export interface OutboundArtifactRef {
  taskId: string;
  relPath: string;
  title?: string;
}

export function withoutDesktopMediaUrls(value: string): string {
  return value.replace(/opc-media:\/\/[^\s)\]>"']+/gi, '[媒体仅在桌面可用]');
}

export function extractArtifactsFromBlocks(
  blocks?: readonly ChatContentBlock[],
): OutboundArtifactRef[] {
  if (!blocks?.length) return [];
  const artifacts: OutboundArtifactRef[] = [];
  for (const block of blocks) {
    if (block.type === 'file') {
      const title = block.title ?? block.name;
      artifacts.push({
        taskId: block.source.taskId,
        relPath: block.source.relPath,
        ...(title ? { title } : {}),
      });
      continue;
    }
    if (
      (block.type === 'image' || block.type === 'video' || block.type === 'audio') &&
      block.source.type === 'artifact'
    ) {
      const title = block.title ?? block.alt;
      artifacts.push({
        taskId: block.source.taskId,
        relPath: block.source.relPath,
        ...(title ? { title } : {}),
      });
    }
  }
  return artifacts;
}
