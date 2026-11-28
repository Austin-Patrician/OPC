import path from 'node:path';
import { BrowserWindow, screen } from 'electron';
import {
  IPC,
  type BuddyOverlayDock,
  type BuddyOverlayPrefsPatch,
  type BuddyOverlaySignalPayload,
  type BuddyOverlaySize,
  type BuddyOverlayState,
  type BuddyScreenPosition,
} from '@opc/shared/ipc';

export interface BuddyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BuddyPoint {
  x: number;
  y: number;
}

export const BUDDY_WINDOW_DIMENSIONS: Record<
  BuddyOverlaySize,
  { width: number; height: number; bearSize: number; bottomPad: number }
> = {
  sm: { width: 248, height: 248, bearSize: 116, bottomPad: 24 },
  md: { width: 268, height: 288, bearSize: 156, bottomPad: 24 },
  lg: { width: 288, height: 328, bearSize: 196, bottomPad: 24 },
};

/**
 * Clamps buddy overlay bounds against a display work area while allowing padding
 * (bubbles/aura) to extend beyond edges as long as at least 72px of the bear remains grabbable.
 */
export function clampBuddyBoundsToWorkArea(
  bounds: BuddyRect,
  workArea: BuddyRect,
  bearSize: number,
  bottomPad: number,
): BuddyRect {
  const keepVisible = Math.min(72, bearSize);
  const leftOffset = (bounds.width - bearSize) / 2;
  const bearRightOffset = leftOffset + bearSize;
  const bearBottomOffset = bounds.height - bottomPad;
  const bearTopOffset = bearBottomOffset - bearSize;

  const minX = workArea.x + keepVisible - bearRightOffset;
  const maxX = Math.max(minX, workArea.x + workArea.width - keepVisible - leftOffset);
  const minY = workArea.y + keepVisible - bearBottomOffset;
  const maxY = Math.max(minY, workArea.y + workArea.height - keepVisible - bearTopOffset);

  return {
    x: Math.round(Math.min(maxX, Math.max(minX, bounds.x))),
    y: Math.round(Math.min(maxY, Math.max(minY, bounds.y))),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

/** Places the floating bear aligned with the main window's bottom-right corner (`right: 24, bottom: 24`). */
export function computeAnchoredBuddyBounds(
  mainBounds: BuddyRect,
  size: BuddyOverlaySize,
  workArea: BuddyRect,
): BuddyRect {
  const dims = BUDDY_WINDOW_DIMENSIONS[size];
  const rawX = mainBounds.x + mainBounds.width - 24 - (dims.width + dims.bearSize) / 2;
  const rawY = mainBounds.y + mainBounds.height - 24 - (dims.height - dims.bottomPad);
  return clampBuddyBoundsToWorkArea(
    { x: Math.round(rawX), y: Math.round(rawY), width: dims.width, height: dims.height },
    workArea,
    dims.bearSize,
    dims.bottomPad,
  );
}

/** Places the floating overlay flush on the display's right edge for side-peek docking. */
export function computePeekBuddyBounds(
  currentBounds: BuddyRect,
  size: BuddyOverlaySize,
  workArea: BuddyRect,
): BuddyRect {
  const dims = BUDDY_WINDOW_DIMENSIONS[size];
  const clamped = clampBuddyBoundsToWorkArea(
    {
      x: workArea.x + workArea.width - dims.width,
      y: currentBounds.y,
      width: dims.width,
      height: dims.height,
    },
    workArea,
    dims.bearSize,
    dims.bottomPad,
  );
  return {
    ...clamped,
    x: Math.round(workArea.x + workArea.width - dims.width),
  };
}

/**
 * Computes new overlay bounds from a cursor delta relative to drag start, explicitly preserving
 * DIP width/height to prevent transparent-window drift across mixed-DPI monitors on Windows.
 */
export function computeDraggedBuddyBounds(
  startWin: BuddyRect,
  startCursor: BuddyPoint,
  currentCursor: BuddyPoint,
  size: BuddyOverlaySize,
  workArea: BuddyRect,
): BuddyRect {
  const dims = BUDDY_WINDOW_DIMENSIONS[size];
  return clampBuddyBoundsToWorkArea(
    {
      x: Math.round(startWin.x + (currentCursor.x - startCursor.x)),
      y: Math.round(startWin.y + (currentCursor.y - startCursor.y)),
      width: dims.width,
      height: dims.height,
    },
    workArea,
    dims.bearSize,
    dims.bottomPad,
  );
}

/** Keeps the bottom-center bear anchor steady when cycling companion size. */
export function computeResizedBuddyBounds(
  currentBounds: BuddyRect,
  nextSize: BuddyOverlaySize,
  workArea: BuddyRect,
): BuddyRect {
  const dims = BUDDY_WINDOW_DIMENSIONS[nextSize];
  const prevCenterX = currentBounds.x + currentBounds.width / 2;
  const prevBottom = currentBounds.y + currentBounds.height;
  return clampBuddyBoundsToWorkArea(
    {
      x: Math.round(prevCenterX - dims.width / 2),
      y: Math.round(prevBottom - dims.height),
      width: dims.width,
      height: dims.height,
    },
    workArea,
    dims.bearSize,
    dims.bottomPad,
  );
}

/** Determines whether the desktop floating Buddy overlay should be displayed. */
export function shouldShowBuddyOverlay(
  state: BuddyOverlayState | null,
  mainWindowOpen: boolean,
): boolean {
  if (!mainWindowOpen || !state) return false;
  if (!state.enabled || !state.desktopFloat) return false;
  if (state.hidden && !state.screenPosition) return false;
  return true;
}

export interface BuddyWindowServiceOptions {
  mainDir: string;
  isDev: boolean;
  rendererUrl?: string;
  isSmoke?: boolean;
}

/**
 * Manages the standalone transparent, frameless, click-through Electron `BrowserWindow`
 * that hosts Buddy above the desktop and tracks `mainWindow` when not manually dragged elsewhere.
 */
export class BuddyWindowService {
  private mainWindow: BrowserWindow | null = null;
  private unbindMainListeners: (() => void) | null = null;
  private buddyWindow: BrowserWindow | null = null;
  private buddyReady = false;
  private state: BuddyOverlayState | null = null;
  private interactive = false;
  private prePeekBounds: BuddyRect | null = null;
  private dragSession: {
    startCursor: BuddyPoint;
    startWin: BuddyRect;
    timer: ReturnType<typeof setInterval>;
  } | null = null;

  constructor(private readonly options: BuddyWindowServiceOptions) {}

  isBuddyWindow(win: BrowserWindow | null | undefined): boolean {
    return Boolean(win && this.buddyWindow && win === this.buddyWindow);
  }

  attachMainWindow(win: BrowserWindow): void {
    this.unbindMainListeners?.();
    this.mainWindow = win;

    const handleMoveOrResize = () => {
      this.repositionAnchoredIfNeeded();
    };
    const handleClosed = () => {
      this.unbindMainListeners?.();
      this.unbindMainListeners = null;
      this.mainWindow = null;
      this.cancelDragSession();
      this.destroyBuddyWindow();
    };

    win.on('move', handleMoveOrResize);
    win.on('resize', handleMoveOrResize);
    win.on('closed', handleClosed);

    this.unbindMainListeners = () => {
      if (!win.isDestroyed()) {
        win.off('move', handleMoveOrResize);
        win.off('resize', handleMoveOrResize);
        win.off('closed', handleClosed);
      }
    };

    this.applyCurrentVisibilityAndBounds();
  }

  getState(): BuddyOverlayState | null {
    return this.state;
  }

  syncState(next: BuddyOverlayState): void {
    const prev = this.state;
    this.state = next;

    if (this.buddyWindow && !this.buddyWindow.isDestroyed() && this.buddyReady) {
      this.buddyWindow.webContents.send(IPC.buddy.stateEvent, next);
    }

    if (!next.enabled || !next.desktopFloat) {
      this.cancelDragSession();
      this.destroyBuddyWindow();
      return;
    }

    const visible = this.isOverlayVisible(next);
    if (!visible) {
      this.cancelDragSession();
      if (this.buddyWindow && !this.buddyWindow.isDestroyed()) {
        this.buddyWindow.hide();
      }
      return;
    }

    const win = this.ensureBuddyWindow();
    this.applyWindowLevel(win, next.alwaysOnTop);

    if (!this.buddyReady) return;

    const currentBounds = win.getBounds();
    const sizeChanged = prev !== null && prev.size !== next.size;
    const dockChanged = prev !== null && prev.dock !== next.dock;
    const positionCleared = Boolean(prev?.screenPosition && !next.screenPosition);

    let targetBounds: BuddyRect | null = null;
    if (next.dock === 'peek' && (dockChanged || !prev)) {
      this.prePeekBounds = currentBounds;
      targetBounds = computePeekBuddyBounds(
        currentBounds,
        next.size,
        this.workAreaForRect(currentBounds),
      );
    } else if (prev?.dock === 'peek' && next.dock !== 'peek') {
      targetBounds = this.resolveFloatingBounds(next, this.prePeekBounds ?? currentBounds);
      this.prePeekBounds = null;
    } else if (next.dock === 'peek' && sizeChanged) {
      targetBounds = computePeekBuddyBounds(
        currentBounds,
        next.size,
        this.workAreaForRect(currentBounds),
      );
    } else if (positionCleared) {
      targetBounds = this.resolveFloatingBounds(next, currentBounds);
    } else if (sizeChanged && next.screenPosition) {
      targetBounds = computeResizedBuddyBounds(
        currentBounds,
        next.size,
        this.workAreaForRect(currentBounds),
      );
    } else if (sizeChanged || !win.isVisible()) {
      targetBounds = this.resolveFloatingBounds(next, currentBounds);
    }

    if (targetBounds) {
      win.setBounds(targetBounds);
      if (next.screenPosition && next.dock !== 'peek' && (sizeChanged || !win.isVisible())) {
        const nextPos = { x: targetBounds.x, y: targetBounds.y };
        if (nextPos.x !== next.screenPosition.x || nextPos.y !== next.screenPosition.y) {
          this.state = { ...next, screenPosition: nextPos };
          this.pushPrefsPatchToMain({ screenPosition: nextPos });
        }
      }
    }

    if (!win.isVisible()) {
      win.showInactive();
    }
  }

  emitSignal(signal: BuddyOverlaySignalPayload): void {
    if (this.buddyWindow && !this.buddyWindow.isDestroyed() && this.buddyReady) {
      this.buddyWindow.webContents.send(IPC.buddy.signalEvent, signal);
    }
  }

  setInteractive(interactive: boolean): void {
    if (!this.buddyWindow || this.buddyWindow.isDestroyed()) return;
    const effective = this.dragSession ? true : interactive;
    if (this.interactive === effective) return;
    this.interactive = effective;
    this.buddyWindow.setIgnoreMouseEvents(!effective, { forward: true });
  }

  dragStart(): void {
    if (!this.buddyWindow || this.buddyWindow.isDestroyed() || !this.state) return;
    this.cancelDragSession();
    const startCursor = screen.getCursorScreenPoint();
    const startWin = this.buddyWindow.getBounds();
    this.setInteractive(true);
    const timer = setInterval(() => {
      this.dragMove();
    }, 16);
    timer.unref?.();
    this.dragSession = { startCursor, startWin, timer };
  }

  dragMove(): void {
    if (!this.dragSession || !this.buddyWindow || this.buddyWindow.isDestroyed() || !this.state) {
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const workArea = screen.getDisplayNearestPoint(cursor).workArea;
    const next = computeDraggedBuddyBounds(
      this.dragSession.startWin,
      this.dragSession.startCursor,
      cursor,
      this.state.size,
      workArea,
    );
    this.buddyWindow.setBounds(next);
  }

  dragEnd(): BuddyScreenPosition | null {
    if (!this.dragSession) return this.state?.screenPosition ?? null;
    this.dragMove();
    this.cancelDragSession();
    if (!this.buddyWindow || this.buddyWindow.isDestroyed()) return null;
    const finalBounds = this.buddyWindow.getBounds();
    const pos: BuddyScreenPosition = { x: finalBounds.x, y: finalBounds.y };
    if (this.state) {
      this.state = { ...this.state, dock: 'floating', screenPosition: pos };
    }
    this.pushPrefsPatchToMain({ dock: 'floating', screenPosition: pos });
    return pos;
  }

  resetPosition(): void {
    this.cancelDragSession();
    this.prePeekBounds = null;
    if (this.state) {
      this.state = { ...this.state, dock: 'floating', screenPosition: null };
    }
    this.pushPrefsPatchToMain({ dock: 'floating', screenPosition: null });
    this.repositionAnchoredIfNeeded();
  }

  updatePrefsFromOverlay(patch: BuddyOverlayPrefsPatch): void {
    if (this.state) {
      const next: BuddyOverlayState = {
        ...this.state,
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.desktopFloat !== undefined ? { desktopFloat: patch.desktopFloat } : {}),
        ...(patch.alwaysOnTop !== undefined ? { alwaysOnTop: patch.alwaysOnTop } : {}),
        ...(patch.size !== undefined ? { size: patch.size } : {}),
        ...(patch.dock !== undefined ? { dock: patch.dock as BuddyOverlayDock } : {}),
        ...(patch.bubbles !== undefined ? { bubbles: patch.bubbles } : {}),
        ...(patch.screenPosition !== undefined ? { screenPosition: patch.screenPosition } : {}),
      };
      this.syncState(next);
    }
    this.pushPrefsPatchToMain(patch);
  }

  focusMain(route?: string): void {
    const win = this.mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (route) {
      win.webContents.send(IPC.buddy.navigateEvent, route);
    }
  }

  dispose(): void {
    this.cancelDragSession();
    this.unbindMainListeners?.();
    this.unbindMainListeners = null;
    this.mainWindow = null;
    this.destroyBuddyWindow();
  }

  private isOverlayVisible(state: BuddyOverlayState | null): boolean {
    if (this.options.isSmoke) return false;
    const mainOpen = Boolean(this.mainWindow && !this.mainWindow.isDestroyed());
    return shouldShowBuddyOverlay(state, mainOpen);
  }

  private workAreaForRect(rect: BuddyRect): BuddyRect {
    return screen.getDisplayMatching(rect).workArea;
  }

  private resolveFloatingBounds(
    state: BuddyOverlayState,
    fallbackBounds?: BuddyRect,
  ): BuddyRect {
    const dims = BUDDY_WINDOW_DIMENSIONS[state.size];
    if (state.screenPosition) {
      const candidate: BuddyRect = {
        x: state.screenPosition.x,
        y: state.screenPosition.y,
        width: dims.width,
        height: dims.height,
      };
      return clampBuddyBoundsToWorkArea(
        candidate,
        this.workAreaForRect(candidate),
        dims.bearSize,
        dims.bottomPad,
      );
    }
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const mainBounds = this.mainWindow.getBounds();
      return computeAnchoredBuddyBounds(mainBounds, state.size, this.workAreaForRect(mainBounds));
    }
    const base = fallbackBounds ?? { x: 100, y: 100, width: dims.width, height: dims.height };
    return clampBuddyBoundsToWorkArea(
      { ...base, width: dims.width, height: dims.height },
      screen.getPrimaryDisplay().workArea,
      dims.bearSize,
      dims.bottomPad,
    );
  }

  private repositionAnchoredIfNeeded(): void {
    if (!this.buddyWindow || this.buddyWindow.isDestroyed() || !this.buddyReady) return;
    if (!this.state || this.state.screenPosition || this.state.dock === 'peek' || this.dragSession) {
      return;
    }
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    const mainBounds = this.mainWindow.getBounds();
    const target = computeAnchoredBuddyBounds(
      mainBounds,
      this.state.size,
      this.workAreaForRect(mainBounds),
    );
    this.buddyWindow.setBounds(target);
  }

  private applyCurrentVisibilityAndBounds(): void {
    if (!this.state) return;
    this.syncState(this.state);
  }

  private ensureBuddyWindow(): BrowserWindow {
    if (this.buddyWindow && !this.buddyWindow.isDestroyed()) {
      return this.buddyWindow;
    }

    const size = this.state?.size ?? 'md';
    const initialBounds = this.state
      ? this.resolveFloatingBounds(this.state)
      : { x: 0, y: 0, width: BUDDY_WINDOW_DIMENSIONS[size].width, height: BUDDY_WINDOW_DIMENSIONS[size].height };

    this.buddyReady = false;
    this.interactive = false;

    const win = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(this.options.mainDir, '../preload/index.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });

    win.setIgnoreMouseEvents(true, { forward: true });
    this.applyWindowLevel(win, this.state?.alwaysOnTop ?? true);

    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      this.buddyReady = true;
      if (this.state) {
        win.webContents.send(IPC.buddy.stateEvent, this.state);
      }
      if (this.isOverlayVisible(this.state)) {
        const bounds = this.state!.dock === 'peek'
          ? computePeekBuddyBounds(
              this.resolveFloatingBounds(this.state!),
              this.state!.size,
              this.workAreaForRect(win.getBounds()),
            )
          : this.resolveFloatingBounds(this.state!);
        win.setBounds(bounds);
        win.showInactive();
      }
    });

    win.on('closed', () => {
      this.cancelDragSession();
      if (this.buddyWindow === win) {
        this.buddyWindow = null;
        this.buddyReady = false;
        this.interactive = false;
      }
    });

    if (this.options.isDev && this.options.rendererUrl) {
      const origin = this.options.rendererUrl.replace(/\/$/, '');
      void win.loadURL(`${origin}/buddy.html`);
    } else {
      void win.loadFile(path.join(this.options.mainDir, '../renderer/buddy.html'));
    }

    this.buddyWindow = win;
    return win;
  }

  private applyWindowLevel(win: BrowserWindow, alwaysOnTop: boolean): void {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(alwaysOnTop, process.platform === 'darwin' ? 'floating' : 'normal');
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: false });
    }
  }

  private pushPrefsPatchToMain(patch: BuddyOverlayPrefsPatch): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC.buddy.prefsPatchEvent, patch);
    }
  }

  private cancelDragSession(): void {
    if (!this.dragSession) return;
    clearInterval(this.dragSession.timer);
    this.dragSession = null;
  }

  private destroyBuddyWindow(): void {
    const win = this.buddyWindow;
    this.buddyWindow = null;
    this.buddyReady = false;
    this.interactive = false;
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }
}
