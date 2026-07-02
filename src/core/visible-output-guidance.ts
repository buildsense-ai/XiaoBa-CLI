import type { Message } from '../types';
import type { ToolDefinition, ToolSurface } from '../types/tool';
import { renderRequiredDefaultPromptFile } from '../utils/prompt-template';
import type { TransientTurnIntent } from './transient-injection-policy';

export const TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX = '[transient_visible_output_guidance]';

export interface BuildVisibleOutputGuidanceOptions {
  surface?: ToolSurface;
  tools: ToolDefinition[];
  intent: TransientTurnIntent;
}

const MESSAGE_SURFACES = new Set<ToolSurface>(['weixin', 'feishu', 'catscompany']);

export function buildVisibleOutputGuidance(
  options: BuildVisibleOutputGuidanceOptions,
): Message | null {
  const deliveryPath = describeDeliveryPath(options.tools);
  const artifactPreference = describeArtifactPreference(options.surface);
  const content = renderRequiredDefaultPromptFile('transient/visible-output-guidance.md', {
    surface: describeSurface(options.surface),
    deliveryPath,
    artifactPreference,
  });

  return {
    role: 'user',
    content: `${TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX}\n${content}`,
    __injected: true,
  };
}

export function shouldInjectVisibleOutputGuidance(params: {
  surface?: ToolSurface;
  intent: TransientTurnIntent;
  turn: number;
  executedToolCalls: number;
}): boolean {
  if (params.intent.plainChat) return false;
  if (MESSAGE_SURFACES.has(params.surface || 'unknown')) return true;
  if (params.intent.complexWork) return true;
  if (params.intent.kind === 'office' || params.intent.kind === 'classroom' || params.intent.kind === 'team') return true;
  return false;
}

function describeDeliveryPath(tools: ToolDefinition[]): string {
  const names = new Set(tools.map(tool => tool.name));
  const paths: string[] = [];
  if (names.has('write_file')) {
    paths.push('write_file for local artifacts, drafts, and source-backed files');
  }
  if (names.has('send_file')) {
    paths.push('send_file for chat file delivery after a file exists');
  }
  if (names.has('edit_file')) {
    paths.push('edit_file for existing files');
  }
  return paths.length > 0
    ? paths.join('; ')
    : 'no file/artifact tool is currently enabled';
}

function describeArtifactPreference(surface?: ToolSurface): string {
  switch (surface) {
    case 'weixin':
    case 'feishu':
    case 'catscompany':
      return [
        'For chat delivery, prefer user-openable document formats for reports, handouts, tables, and other user-facing deliverables.',
        'Use Word (.docx) when the user may edit or reuse the document; use PDF when a read-only share is better.',
        'Do not default to Markdown as the final delivered file unless the user asks for Markdown, the task is developer/source notes, or no better document-producing path is available.',
      ].join(' ');
    case 'cli':
    case 'agent':
    case 'research':
      return 'Markdown or plain text can be appropriate for developer notes, CLI workflows, drafts, and source-oriented outputs; use Word (.docx) or PDF for polished user-facing documents when available.';
    default:
      return 'Prefer the most user-openable artifact format for the current surface; avoid Markdown as a final user-facing chat attachment unless it is explicitly requested or clearly appropriate.';
  }
}

function describeSurface(surface?: ToolSurface): string {
  switch (surface) {
    case 'weixin':
      return 'weixin chat, where visible replies should be especially compact and Markdown files are a poor final-delivery experience';
    case 'feishu':
      return 'feishu chat, where concise replies plus user-openable files are preferred for long deliverables';
    case 'catscompany':
      return 'CatsCo web/chat surface, where concise visible replies and user-openable artifact links/cards are preferred';
    case 'cli':
      return 'CLI, where concise terminal output is still preferred for long deliverables';
    case 'agent':
      return 'agent-to-agent context';
    case 'research':
      return 'research context';
    default:
      return 'unknown/default chat surface';
  }
}
