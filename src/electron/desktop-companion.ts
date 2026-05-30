export type DesktopAction = 'minimize-all' | 'restore-all';
export type ScreenEdge = 'left' | 'right';

export interface UserDataPathOptions {
  env: Record<string, string | undefined>;
  appRoot: string;
  defaultPath: string;
}

export interface EdgePetBoundsOptions {
  display: { width: number; height: number };
  window: { width: number; height: number };
  edge?: ScreenEdge;
  visibleWidth?: number;
}

export interface DesktopPetBoundsOptions {
  display: { width: number; height: number };
  window: { width: number; height: number };
  marginX?: number;
  marginBottom?: number;
}

export interface DraggedDesktopPetBoundsOptions {
  current: WindowBounds;
  display: { width: number; height: number };
  delta: { x: number; y: number };
  padding?: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function resolveDashboardPort(env: Record<string, string | undefined>, fallback = 3800): number {
  const raw = String(env.DASHBOARD_PORT || '').trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

export function resolveUserDataPath(options: UserDataPathOptions): string {
  const explicit = String(options.env.XIAOBA_USER_DATA_DIR || '').trim();
  return explicit || options.defaultPath;
}

export function buildDesktopPowerShellArgs(action: DesktopAction): string[] {
  if (action === 'minimize-all') {
    return [
      '-NoProfile',
      '-Command',
      '(New-Object -ComObject Shell.Application).MinimizeAll()',
    ];
  }

  if (action === 'restore-all') {
    return [
      '-NoProfile',
      '-Command',
      '(New-Object -ComObject Shell.Application).UndoMinimizeAll()',
    ];
  }

  throw new Error(`Unsupported desktop action: ${String(action)}`);
}

export function resolveEdgePetBounds(options: EdgePetBoundsOptions): WindowBounds {
  const edge = options.edge || 'right';
  const visibleWidth = Math.max(24, Math.min(options.window.width, options.visibleWidth || 136));
  const hiddenWidth = options.window.width - visibleWidth;
  const y = Math.round((options.display.height - options.window.height) / 2);
  const x = edge === 'left'
    ? -hiddenWidth
    : options.display.width - visibleWidth;

  return {
    x,
    y,
    width: options.window.width,
    height: options.window.height,
  };
}

export function resolveDesktopPetBounds(options: DesktopPetBoundsOptions): WindowBounds {
  const marginX = options.marginX ?? 32;
  const marginBottom = options.marginBottom ?? 72;
  const x = Math.max(marginX, options.display.width - options.window.width - marginX);
  const y = Math.max(8, options.display.height - options.window.height - marginBottom);

  return {
    x,
    y,
    width: options.window.width,
    height: options.window.height,
  };
}

export function resolveDraggedDesktopPetBounds(options: DraggedDesktopPetBoundsOptions): WindowBounds {
  const padding = options.padding ?? 8;
  const maxX = Math.max(padding, options.display.width - options.current.width - padding);
  const maxY = Math.max(padding, options.display.height - options.current.height - padding);
  const nextX = options.current.x + options.delta.x;
  const nextY = options.current.y + options.delta.y;

  return {
    x: Math.max(padding, Math.min(maxX, Math.round(nextX))),
    y: Math.max(padding, Math.min(maxY, Math.round(nextY))),
    width: options.current.width,
    height: options.current.height,
  };
}
