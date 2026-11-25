import type { CSSProperties } from 'react';
import terminalBashSvg from '@/shared/icons/common-icons/terminal-bash.svg';
import readFileSvg from '@/shared/icons/common-icons/read_file.svg';
import writeSvg from '@/shared/icons/common-icons/Write.svg';
import editSvg from '@/shared/icons/common-icons/edit.svg';
import findSvg from '@/shared/icons/common-icons/find.svg';
import folderSvg from '@/shared/icons/common-icons/floder.svg';
import grepSvg from '@/shared/icons/common-icons/grep.svg';
import pdfSvg from '@/shared/icons/common-icons/extract_text_from_pdf.svg';
import docxSvg from '@/shared/icons/common-icons/extract_text_from_docx.svg';
import ocrImageSvg from '@/shared/icons/common-icons/extract_text_from_image.svg';
import fetchUrlSvg from '@/shared/icons/common-icons/fetch_url.svg';
import webSvg from '@/shared/icons/common-icons/网站.svg';
import screenshotSvg from '@/shared/icons/common-icons/design_screenshot.svg';
import delegateTaskSvg from '@/shared/icons/common-icons/delegate_task.svg';
import kbQuerySvg from '@/shared/icons/common-icons/kb_query.svg';
import kbWriteSvg from '@/shared/icons/common-icons/kb_write_page.svg';
import kbRetireSvg from '@/shared/icons/common-icons/kb_retire_page.svg';
import listSvg from '@/shared/icons/common-icons/list.svg';
import compressContextSvg from '@/shared/icons/common-icons/compress-context.svg';
import toolApprovalSvg from '@/shared/icons/common-icons/tool-approval.svg';
import loadSkillSvg from '@/shared/icons/common-icons/load_skill.svg';
import deepThinkSvg from '@/shared/icons/common-icons/深度思考.svg';
import modelRequestSvg from '@/shared/icons/common-icons/模型请求.svg';
import mcpSvg from '@/shared/icons/common-icons/mcp.svg';
import agentModeSvg from '@/shared/icons/common-icons/agent-mode.svg';
import emptySvg from '@/shared/icons/common-icons/数据空空如也.svg';
import errorSvg from '@/shared/icons/common-icons/main-loading-error.svg';
import presentationSvg from '@/shared/icons/common-icons/presentation.svg';

import webSearchColorSvg from '@/shared/icons/mcp/websearch.svg';
import firecrawlColorSvg from '@/shared/icons/mcp/firecrawl-color.svg';
import figmaColorSvg from '@/shared/icons/mcp/figma-color.svg';
import githubFillSvg from '@/shared/icons/mcp/github-fill.svg';
import postgresSvg from '@/shared/icons/mcp/PostgreSQL.svg';
import feishuSvg from '@/shared/icons/mcp/飞书.svg';
import dingtalkSvg from '@/shared/icons/mcp/钉钉.svg';
import wecomSvg from '@/shared/icons/mcp/企业微信.svg';

import wsFilesSvg from '@/shared/icons/workspaces/files.svg';
import wsReportSvg from '@/shared/icons/workspaces/REPORT.svg';
import wsSheetsSvg from '@/shared/icons/workspaces/sheets.svg';
import wsChartsSvg from '@/shared/icons/workspaces/charts.svg';

export type IconRenderMode = 'mask' | 'color';

export interface ObservatoryVisual {
  src: string;
  mode: IconRenderMode;
  toneClass: string;
}

export const EMPTY_STATE_VISUAL: ObservatoryVisual = {
  src: emptySvg,
  mode: 'mask',
  toneClass: 'text-ink-quaternary',
};

export const ERROR_STATE_VISUAL: ObservatoryVisual = {
  src: errorSvg,
  mode: 'mask',
  toneClass: 'text-danger',
};

export const APPROVAL_VISUAL: ObservatoryVisual = {
  src: toolApprovalSvg,
  mode: 'mask',
  toneClass: 'text-warning',
};

export const COMPACT_VISUAL: ObservatoryVisual = {
  src: compressContextSvg,
  mode: 'mask',
  toneClass: 'text-ink-secondary',
};

export const TURN_THINK_VISUAL: ObservatoryVisual = {
  src: deepThinkSvg,
  mode: 'mask',
  toneClass: 'text-accent-ink',
};

export const TURN_BATCH_VISUAL: ObservatoryVisual = {
  src: modelRequestSvg,
  mode: 'mask',
  toneClass: 'text-ink-secondary',
};

export function ObservatoryIcon({
  visual,
  size = 15,
  className = '',
}: {
  visual: Pick<ObservatoryVisual, 'src' | 'mode' | 'toneClass'>;
  size?: number;
  className?: string;
}) {
  if (visual.mode === 'color') {
    return (
      <img
        src={visual.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ width: size, height: size }}
        className={`shrink-0 object-contain ${className}`}
      />
    );
  }

  const maskUrl = `url("${visual.src}")`;
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: 'currentColor',
    maskImage: maskUrl,
    WebkitMaskImage: maskUrl,
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
    maskSize: 'contain',
    WebkitMaskSize: 'contain',
  };

  return (
    <span
      aria-hidden="true"
      style={style}
      className={`inline-block shrink-0 ${visual.toneClass} ${className}`}
    />
  );
}

function stripNestedSuffix(name: string): string {
  return name.replace(/（嵌套）$/, '').trim();
}

function resolveMcpVisual(serverPrefix: string): ObservatoryVisual {
  const s = serverPrefix.toLowerCase();
  if (s.includes('figma')) return { src: figmaColorSvg, mode: 'color', toneClass: '' };
  if (s.includes('firecrawl')) return { src: firecrawlColorSvg, mode: 'color', toneClass: '' };
  if (s.includes('github')) return { src: githubFillSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  if (s.includes('postgres')) return { src: postgresSvg, mode: 'color', toneClass: '' };
  if (s.includes('feishu') || s.includes('lark')) return { src: feishuSvg, mode: 'color', toneClass: '' };
  if (s.includes('ding')) return { src: dingtalkSvg, mode: 'color', toneClass: '' };
  if (s.includes('wecom') || s.includes('wechat')) return { src: wecomSvg, mode: 'color', toneClass: '' };
  return { src: mcpSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
}

/**
 * Resolves a Worker or Router tool/event name (+ digest hint) into a custom SVG icon.
 * Monochrome SVGs use CSS mask tinting so they remain legible in both light & dark themes.
 */
export function resolveToolVisual(toolName: string, argsDigest = ''): ObservatoryVisual {
  const clean = stripNestedSuffix(toolName).toLowerCase();
  const digestLower = argsDigest.toLowerCase();

  const mcpSep = clean.indexOf('__');
  if (mcpSep > 0) {
    return resolveMcpVisual(clean.slice(0, mcpSep));
  }

  if (clean === 'bash' || clean === 'shell' || clean === 'exec' || clean === 'run_command') {
    return { src: terminalBashSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }

  if (clean === 'read' || clean === 'read_file') {
    if (digestLower.includes('.pdf')) {
      return { src: pdfSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
    }
    if (digestLower.includes('.docx') || digestLower.includes('.doc')) {
      return { src: docxSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
    }
    return { src: readFileSvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }

  if (clean === 'write' || clean === 'write_file') {
    return { src: writeSvg, mode: 'mask', toneClass: 'text-accent-ink' };
  }
  if (clean === 'edit' || clean === 'edit_file') {
    return { src: editSvg, mode: 'mask', toneClass: 'text-accent-ink' };
  }
  if (clean === 'find' || clean === 'glob') {
    return { src: findSvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }
  if (clean === 'ls' || clean === 'list_dir') {
    return { src: folderSvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }
  if (clean === 'grep' || clean === 'search') {
    return { src: grepSvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }
  if (clean === 'ocr_image') {
    return { src: ocrImageSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }
  if (clean === 'web_search') {
    return { src: webSearchColorSvg, mode: 'color', toneClass: '' };
  }
  if (clean === 'web_crawl' || clean === 'web_crawl_status') {
    return { src: firecrawlColorSvg, mode: 'color', toneClass: '' };
  }
  if (clean === 'web_read' || clean === 'fetch_url') {
    return { src: fetchUrlSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }
  if (clean === 'browser_screenshot') {
    return { src: screenshotSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }
  if (clean.startsWith('browser_')) {
    return { src: webSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }
  if (
    clean === 'open_line_of_work' ||
    clean === 'continue_line' ||
    clean === 'steer_line' ||
    clean === 'decompose_task'
  ) {
    return { src: delegateTaskSvg, mode: 'mask', toneClass: 'text-accent-ink' };
  }
  if (clean === 'recall' || clean === 'recall_memory') {
    return { src: kbQuerySvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }
  if (clean === 'remember') {
    return { src: kbWriteSvg, mode: 'mask', toneClass: 'text-accent-ink' };
  }
  if (clean === 'forget_memory') {
    return { src: kbRetireSvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }
  if (clean === 'list_lines' || clean === 'list_schedules') {
    return { src: listSvg, mode: 'mask', toneClass: 'text-ink-tertiary' };
  }
  if (clean === 'compact') {
    return COMPACT_VISUAL;
  }
  if (clean === 'ask_user' || clean === 'escalate' || clean === 'approval') {
    return APPROVAL_VISUAL;
  }
  if (clean === 'load_skill') {
    return { src: loadSkillSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }
  if (
    clean === 'deliver' ||
    clean === 'reply_to_user' ||
    clean === 'reply_complete' ||
    clean === 'dispatch_complete' ||
    clean === '纯文本回复'
  ) {
    return TURN_BATCH_VISUAL;
  }
  if (clean === 'passthrough' || clean === 'decide' || clean === 'investigate') {
    return TURN_THINK_VISUAL;
  }
  if (
    clean === 'turn_error' ||
    clean === 'protocol_error' ||
    clean === 'abort_line' ||
    clean === '输出截断' ||
    clean === '模型响应异常'
  ) {
    return ERROR_STATE_VISUAL;
  }
  if (clean === 'desktop_screenshot' || clean.startsWith('desktop_')) {
    return { src: screenshotSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
  }
  return { src: agentModeSvg, mode: 'mask', toneClass: 'text-ink-secondary' };
}

/** Resolves an artifact relative path into an icon visual. */
export function resolveArtifactVisual(relPath: string): ObservatoryVisual {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.pdf')) {
    return { src: pdfSvg, mode: 'mask', toneClass: 'text-danger' };
  }
  if (lower.endsWith('.docx') || lower.endsWith('.doc')) {
    return { src: docxSvg, mode: 'mask', toneClass: 'text-accent-ink' };
  }
  if (lower.endsWith('.pptx') || lower.endsWith('.ppt')) {
    return { src: presentationSvg, mode: 'mask', toneClass: 'text-warning' };
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv')) {
    return { src: wsSheetsSvg, mode: 'color', toneClass: '' };
  }
  if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.html')) {
    return { src: wsReportSvg, mode: 'color', toneClass: '' };
  }
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.svg')
  ) {
    return { src: wsChartsSvg, mode: 'color', toneClass: '' };
  }
  return { src: wsFilesSvg, mode: 'color', toneClass: '' };
}
