const { app, BrowserWindow, ipcMain, screen, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

/* 玻璃模糊需要 GPU；进程内 GPU 降低部分环境的崩溃概率 */
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('wm-window-animations-disabled');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;
  let saveTimer = null;
  let collapsed = false;
  let dockRight = true;
  let savedBounds = null;
  let peeking = true;
  let hideTimer = null;
  let edgeTimer = null;
  let edgeCooldown = false;
  let revealed = false;
  let fitting = false;
  let userSized = false;
  let dragging = false;
  let dragOx = 0;
  let dragOy = 0;
  let dragMoved = false;
  let dragStartPt = null;
  let edgePt = null;
  let dragTimer = null;

  const BADGE = 56;
  const SLIVER = 10;
  const MIN_W = 260;
  const MIN_H = 140;

  const boundsFile = () => path.join(app.getPath('userData'), 'bounds.json');

  function defaultBounds() {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      width: 312,
      height: 360,
      x: Math.max(wa.x + 20, wa.x + wa.width - 340),
      y: wa.y + 72
    };
  }

  function clampBounds(b) {
    const displays = screen.getAllDisplays();
    let wa = screen.getPrimaryDisplay().workArea;
    for (let i = 0; i < displays.length; i++) {
      const r = displays[i].workArea;
      if (b.x < r.x + r.width && b.x + 40 > r.x &&
          b.y < r.y + r.height && b.y + 40 > r.y) {
        wa = r;
        break;
      }
    }
    const width = Math.min(Math.max(MIN_W, b.width), wa.width - 16);
    const height = Math.min(Math.max(MIN_H, b.height), wa.height - 16);
    const x = Math.min(Math.max(Math.round(b.x), wa.x + 8), wa.x + wa.width - width - 8);
    const y = Math.min(Math.max(Math.round(b.y), wa.y + 8), wa.y + wa.height - height - 8);
    return { x, y, width, height };
  }

  function loadBounds() {
    try {
      const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
      if (b && typeof b.x === 'number' && typeof b.y === 'number') {
        return clampBounds({
          x: b.x,
          y: b.y,
          width: 312,
          height: typeof b.height === 'number' ? Math.min(b.height, 360) : 360
        });
      }
    } catch (e) {}
    return defaultBounds();
  }

  function saveBounds() {
    if (!win || collapsed) return;
    try {
      fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
    } catch (e) {}
  }

  function scheduleSave() {
    if (collapsed) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 400);
  }

  function workArea() {
    const b = win ? win.getBounds() : defaultBounds();
    return screen.getDisplayMatching(b).workArea;
  }

  function clampY(y) {
    const wa = workArea();
    return Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - BADGE - 4);
  }

  function badgeVisibleBounds() {
    const wa = workArea();
    const y = clampY(win.getBounds().y);
    const x = dockRight ? wa.x + wa.width - BADGE : wa.x;
    return { x, y, width: BADGE, height: BADGE };
  }

  function badgeHiddenBounds() {
    const wa = workArea();
    const y = clampY(win.getBounds().y);
    const x = dockRight
      ? wa.x + wa.width - SLIVER
      : wa.x + SLIVER - BADGE;
    return { x, y, width: BADGE, height: BADGE };
  }

  function applyBadgeBounds(hidden) {
    if (!win) return;
    win.setBounds(hidden ? badgeHiddenBounds() : badgeVisibleBounds());
  }

  function visibleRatio(b) {
    const box = b || (win && win.getBounds());
    if (!box) return 1;
    const area = Math.max(1, box.width * box.height);
    let vis = 0;
    screen.getAllDisplays().forEach((d) => {
      const r = d.bounds;
      const w = Math.max(0, Math.min(box.x + box.width, r.x + r.width) - Math.max(box.x, r.x));
      const h = Math.max(0, Math.min(box.y + box.height, r.y + r.height) - Math.max(box.y, r.y));
      vis += w * h;
    });
    return vis / area;
  }

  function moreThanHalfOffscreen() {
    return visibleRatio() < 0.5;
  }

  function nearestDockRight(b) {
    const box = b || win.getBounds();
    const wa = screen.getDisplayMatching(box).bounds;
    const overflowLeft = Math.max(0, wa.x - box.x);
    const overflowRight = Math.max(0, box.x + box.width - (wa.x + wa.width));
    if (overflowRight > overflowLeft) return true;
    if (overflowLeft > overflowRight) return false;
    return (box.x + box.width / 2) >= (wa.x + wa.width / 2);
  }

  function cursorPulledIn() {
    if (!edgePt) return false;
    const pt = screen.getCursorScreenPoint();
    const pull = 70;
    if (dockRight) return edgePt.x - pt.x >= pull;
    return pt.x - edgePt.x >= pull;
  }

  function collapse(opts) {
    if (!win || collapsed) return;
    const live = !!(opts && opts.live);
    savedBounds = win.getBounds();
    dockRight = nearestDockRight(savedBounds);

    collapsed = true;
    peeking = true;
    edgePt = screen.getCursorScreenPoint();
    clearTimeout(hideTimer);
    win.setResizable(false);
    win.setMinimumSize(BADGE, BADGE);
    win.webContents.send('widget:mode', 'badge', { dockRight });

    const pt = screen.getCursorScreenPoint();
    let x;
    let y;
    if (live) {
      dragOx = Math.round(BADGE / 2);
      dragOy = Math.round(BADGE / 2);
      x = pt.x - dragOx;
      y = pt.y - dragOy;
    } else {
      const wa = screen.getDisplayMatching(savedBounds).workArea;
      x = dockRight ? wa.x + wa.width - BADGE : wa.x;
      y = clampY(savedBounds.y);
    }
    win.setBounds({ x, y, width: BADGE, height: BADGE });
    if (!live) {
      peeking = false;
      scheduleAutoHide();
    }
  }

  function expand(opts) {
    if (!win || !collapsed) return;
    const live = !!(opts && opts.live);
    collapsed = false;
    peeking = true;
    edgePt = null;
    edgeCooldown = true;
    clearTimeout(hideTimer);

    const raw = savedBounds || loadBounds();
    const width = Math.max(MIN_W, raw.width || 312);
    const height = Math.max(MIN_H, raw.height || 360);
    const pt = screen.getCursorScreenPoint();
    let x;
    let y;
    if (live) {
      x = dockRight ? pt.x - (width - 28) : pt.x - 28;
      y = pt.y - 28;
      dragOx = pt.x - x;
      dragOy = pt.y - y;
    } else {
      const b = clampBounds({
        x: raw.x,
        y: raw.y,
        width,
        height
      });
      x = b.x;
      y = b.y;
    }

    win.setMinimumSize(MIN_W, MIN_H);
    win.setResizable(true);
    win.webContents.send('widget:mode', 'widget', { dockRight });
    win.setBounds({ x, y, width, height });
    saveBounds();
    setTimeout(() => { edgeCooldown = false; }, 280);
  }

  function tickDrag() {
    if (!dragging || !win) return;
    const pt = screen.getCursorScreenPoint();
    if (dragStartPt && (Math.abs(pt.x - dragStartPt.x) > 4 || Math.abs(pt.y - dragStartPt.y) > 4)) {
      dragMoved = true;
    }
    if (collapsed) {
      win.setBounds({
        x: pt.x - dragOx,
        y: pt.y - dragOy,
        width: BADGE,
        height: BADGE
      });
      if (!edgeCooldown && cursorPulledIn()) expand({ live: true });
    } else {
      const b = win.getBounds();
      win.setBounds({
        x: pt.x - dragOx,
        y: pt.y - dragOy,
        width: b.width,
        height: b.height
      });
      if (!edgeCooldown && moreThanHalfOffscreen()) collapse({ live: true });
    }
  }

  function beginDrag() {
    if (!win || dragging) return;
    const pt = screen.getCursorScreenPoint();
    const b = win.getBounds();
    dragOx = pt.x - b.x;
    dragOy = pt.y - b.y;
    dragStartPt = { x: pt.x, y: pt.y };
    dragMoved = false;
    dragging = true;
    peeking = true;
    clearTimeout(hideTimer);
    clearInterval(dragTimer);
    dragTimer = setInterval(tickDrag, 16);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    clearInterval(dragTimer);
    dragTimer = null;
    if (!win) return;
    if (collapsed) {
      if (!dragMoved) {
        expand();
        return;
      }
      dockRight = nearestDockRight(win.getBounds());
      applyBadgeBounds(false);
      peeking = false;
      scheduleAutoHide();
    } else {
      scheduleSave();
    }
  }

  function scheduleAutoHide() {
    clearTimeout(hideTimer);
    if (!collapsed) return;
    hideTimer = setTimeout(() => {
      if (!collapsed || peeking) return;
      applyBadgeBounds(true);
    }, 1100);
  }

  function revealWindow() {
    if (!win || revealed) return;
    revealed = true;
    win.setOpacity(1);
    win.show();
  }

  function createWindow() {
    const b = loadBounds();
    win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      minWidth: MIN_W,
      minHeight: MIN_H,
      show: false,
      opacity: 0,
      transparent: true,
      frame: false,
      resizable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    Menu.setApplicationMenu(null);
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setBackgroundColor('#00000000');
    win.loadFile(path.join(__dirname, 'todo.html'));
    setTimeout(revealWindow, 1800);

    win.on('moved', () => {
      if (dragging || collapsed) return;
      scheduleSave();
    });
    win.on('resized', () => {
      if (collapsed) return;
      if (!fitting && revealed) userSized = true;
      scheduleSave();
    });
    win.on('close', () => {
      if (!collapsed) saveBounds();
    });
  }

  ipcMain.handle('widget:getBounds', () => {
    if (!win) return defaultBounds();
    return win.getBounds();
  });

  ipcMain.on('widget:fit', (e, size) => {
    if (!win || collapsed || !size) return;
    if (userSized) {
      revealWindow();
      return;
    }
    const b = win.getBounds();
    const next = clampBounds({
      x: b.x,
      y: b.y,
      width: Number(size.width) || b.width,
      height: Number(size.height) || b.height
    });
    fitting = true;
    win.setMinimumSize(MIN_W, MIN_H);
    win.setBounds(next);
    fitting = false;
    scheduleSave();
    revealWindow();
  });

  ipcMain.on('widget:setBounds', (e, b) => {
    if (!win || collapsed || !b) return;
    if (revealed) userSized = true;
    const width = Math.max(MIN_W, Math.round(Number(b.width) || MIN_W));
    const height = Math.max(MIN_H, Math.round(Number(b.height) || MIN_H));
    const x = Math.round(Number(b.x));
    const y = Math.round(Number(b.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    win.setBounds({ x, y, width, height });
    scheduleSave();
  });

  ipcMain.on('widget:collapse', () => collapse());
  ipcMain.on('widget:expand', () => expand());
  ipcMain.on('widget:beginDrag', () => beginDrag());
  ipcMain.on('widget:endDrag', () => endDrag());

  ipcMain.on('widget:peek', (e, show) => {
    if (!win || !collapsed) return;
    peeking = !!show;
    if (peeking) {
      clearTimeout(hideTimer);
      applyBadgeBounds(false);
    } else {
      scheduleAutoHide();
    }
  });

  ipcMain.on('widget:quit', () => {
    if (!collapsed) saveBounds();
    app.quit();
  });

  function enableAutoStart() {
    const exe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: exe,
        args: [__dirname]
      });
    } catch (e) {}
  }

  app.whenReady().then(() => {
    enableAutoStart();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => {
    if (!win) return;
    if (collapsed) expand();
    win.show();
    win.focus();
  });
}
