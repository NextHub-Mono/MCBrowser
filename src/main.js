const { app, BrowserWindow, BrowserView, ipcMain, session, dialog, Menu, MenuItem, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');

log.transports.file.level = 'info';
autoUpdater.logger = log;

let mainWindow;
let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let isSettingsOpen = false;
let isBookmarkBarOpen = true; 

let HISTORY_FILE;
let BOOKMARKS_FILE;

function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
  }
}
function loadJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function saveJSON(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (err) { console.error(err); } }
const getActiveTab = () => tabs.find(tab => tab.id === activeTabId);

function resizeView() {
  const active = getActiveTab();
  if (!active || !mainWindow) return;

  const bounds = mainWindow.getContentBounds();
  const sidebarWidth = isSettingsOpen ? 320 : 0;
  const topOffset = isBookmarkBarOpen ? 130 : 95; 

  active.view.setBounds({
    x: 0,
    y: topOffset,
    width: bounds.width - sidebarWidth,
    height: bounds.height - topOffset
  });
}

function sendTabs() {
  if (!mainWindow) return;
  mainWindow.webContents.send('tabs-updated', tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })), activeTabId);
}

function addHistory(url, title) {
  const history = loadJSON(HISTORY_FILE);
  history.unshift({ url, title, time: Date.now() });
  saveJSON(HISTORY_FILE, history.slice(0, 500));
}

function registerContextMenu(viewWebContents) {
  viewWebContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    if (params.linkURL) {
      menu.append(new MenuItem({ label: '新しいタブでリンクを開く', click: () => { createTab(params.linkURL); } }));
      menu.append(new MenuItem({ label: 'リンクのアドレスをコピー', click: () => { clipboard.writeText(params.linkURL); } }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.hasImageContents) {
      menu.append(new MenuItem({ label: '画像のアドレスをコピー', click: () => { clipboard.writeText(params.srcURL); } }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.selectionText) {
      menu.append(new MenuItem({ label: 'コピー', role: 'copy' }));
      menu.append(new MenuItem({
        label: '選択したテキストで検索',
        click: () => {
          const query = encodeURIComponent(params.selectionText);
          createTab(`https://www.google.com/search?q=${query}`);
        }
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ label: '切り取り', role: 'cut' }));
      menu.append(new MenuItem({ label: '貼り付け', role: 'paste' }));
      menu.append(new MenuItem({ label: 'すべて選択', role: 'selectAll' }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    menu.append(new MenuItem({ label: '戻る', enabled: viewWebContents.canGoBack(), click: () => viewWebContents.goBack() }));
    menu.append(new MenuItem({ label: '進む', enabled: viewWebContents.canGoForward(), click: () => viewWebContents.goForward() }));
    menu.append(new MenuItem({ label: '再読み込み', accelerator: 'CmdOrCtrl+R', click: () => viewWebContents.reload() }));
    menu.append(new MenuItem({ type: 'separator' }));

    menu.append(new MenuItem({ label: '検証（デベロッパーツール）', click: () => { viewWebContents.openDevTools({ mode: 'detach' }); } }));

    menu.popup({ window: mainWindow });
  });
}

function createTab(url = 'file://' + path.join(__dirname, 'newtab.html')) {
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  view.setBackgroundColor('#00000000');
  registerContextMenu(view.webContents);

  const id = ++tabCounter;
  const tab = { id, view, title: '新しいタブ', url };
  tabs.push(tab);

  if (activeTabId !== null) {
    const current = getActiveTab();
    if (current) { try { mainWindow.removeBrowserView(current.view); } catch{} }
  }

  activeTabId = id;
  mainWindow.addBrowserView(view);
  resizeView();

  view.webContents.loadURL(url);

  view.webContents.on('page-title-updated', (_, title) => {
    tab.title = title || '新しいタブ';
    sendTabs();
  });

  view.webContents.on('did-navigate', (_, currentUrl) => {
    tab.url = currentUrl;
    addHistory(currentUrl, tab.title);
    sendTabs();
  });

  view.webContents.on('did-finish-load', () => {
    tab.url = view.webContents.getURL();
    tab.title = view.webContents.getTitle() || tab.title;
    sendTabs();
  });

  sendTabs();
  return id;
}

function switchTab(id) {
  const target = tabs.find(tab => tab.id === id);
  if (!target) return;
  const current = getActiveTab();
  if (current && current.id !== id) { try { mainWindow.removeBrowserView(current.view); } catch{} }
  activeTabId = id;
  mainWindow.addBrowserView(target.view);
  resizeView();
  sendTabs();
}

function closeTab(id) {
  if (tabs.length <= 1) return;
  const index = tabs.findIndex(tab => tab.id === id);
  if (index === -1) return;
  const tab = tabs[index];
  try { mainWindow.removeBrowserView(tab.view); } catch{}
  try { tab.view.webContents.destroy(); } catch{}
  tabs.splice(index, 1);

  if (activeTabId === id) {
    const nextTab = tabs[Math.max(0, index - 1)];
    activeTabId = nextTab.id;
    mainWindow.addBrowserView(nextTab.view);
    resizeView();
  }
  sendTabs();
}

ipcMain.handle('reorder-tabs', (_, reorderedIds) => {
  const newTabs = [];
  reorderedIds.forEach(id => {
    const found = tabs.find(t => t.id === id);
    if (found) newTabs.push(found);
  });
  tabs = newTabs;
  sendTabs();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'icon.ico'), 
    frame: false, 
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => { createTab(); });
  mainWindow.on('resize', resizeView);

  session.defaultSession.on('will-download', (event, item) => {
    const savePath = path.join(app.getPath('downloads'), item.getFilename());
    item.setSavePath(savePath);
    item.on('updated', () => {
      const total = item.getTotalBytes();
      const received = item.getReceivedBytes();
      if (total > 0) mainWindow.setProgressBar(received / total);
    });
    item.once('done', (_, state) => {
      mainWindow.setProgressBar(-1);
      if (state === 'completed') mainWindow.webContents.send('download-complete', savePath);
    });
  });

  autoUpdater.checkForUpdatesAndNotify();
}

ipcMain.handle('navigate', (_, url) => { const active = getActiveTab(); if (active) active.view.webContents.loadURL(url); });
ipcMain.handle('goBack', () => { const active = getActiveTab(); if (active && active.view.webContents.canGoBack()) active.view.webContents.goBack(); });
ipcMain.handle('goForward', () => { const active = getActiveTab(); if (active && active.view.webContents.canGoForward()) active.view.webContents.goForward(); });
ipcMain.handle('reload', () => { const active = getActiveTab(); if (active) active.view.webContents.reload(); });
ipcMain.handle('goHome', () => { const active = getActiveTab(); if (active) active.view.webContents.loadURL('file://' + path.join(__dirname, 'newtab.html')); });
ipcMain.handle('newTab', () => { createTab(); });
ipcMain.handle('switchTab', (_, id) => { switchTab(id); });
ipcMain.handle('closeTab', (_, id) => { closeTab(id); });
ipcMain.handle('getTabs', () => tabs.map(tab => ({ id: tab.id, title: tab.title, url: tab.url })));

ipcMain.handle('set-sidebar-status', (_, isOpen) => {
  isSettingsOpen = isOpen;
  resizeView();
  return true;
});

ipcMain.handle('set-bookmark-bar-status', (_, isOpen) => {
  isBookmarkBarOpen = isOpen;
  resizeView();
  return true;
});

/* Bookmarks & History */
ipcMain.handle('addBookmark', () => {
  const active = getActiveTab();
  if (!active) return false;
  const bookmarks = loadJSON(BOOKMARKS_FILE);
  bookmarks.push({ title: active.view.webContents.getTitle(), url: active.view.webContents.getURL() });
  saveJSON(BOOKMARKS_FILE, bookmarks);
  return true;
});
ipcMain.handle('getBookmarks', () => loadJSON(BOOKMARKS_FILE));
ipcMain.handle('removeBookmark', (_, url) => {
  const bookmarks = loadJSON(BOOKMARKS_FILE);
  saveJSON(BOOKMARKS_FILE, bookmarks.filter(b => b.url !== url));
  return true;
});
ipcMain.handle('getHistory', () => loadJSON(HISTORY_FILE));
ipcMain.handle('clearHistory', () => { saveJSON(HISTORY_FILE, []); return true; });

// パッケージ（.exe）環境用のブックマーク消去確認ダイアログ
ipcMain.handle('confirm-delete-bookmark', async (_, title) => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['削除する', 'キャンセル'],
    defaultId: 1,
    title: 'ブックマークの削除',
    message: `ブックマーク「${title}」を削除しますか？`,
    cancelId: 1
  });
  return result.response === 0;
});

ipcMain.on('open-tab-context-menu', (event, tabId) => {
  const menu = new Menu();
  menu.append(new MenuItem({ label: 'このタブを閉じる', click: () => { closeTab(tabId); } }));
  menu.append(new MenuItem({
    label: '他のタブをすべて閉じる',
    click: () => {
      const targets = [...tabs];
      targets.forEach(t => { if (t.id !== tabId) closeTab(t.id); });
    }
  }));
  menu.popup({ window: mainWindow });
});

ipcMain.on('open-browser-ui-context-menu', () => {
  const menu = new Menu();
  menu.append(new MenuItem({ label: '新しいタブを開く', click: () => { createTab(); } }));
  menu.append(new MenuItem({
    label: 'ブラウザ全体の検証（外枠デバッグ用）',
    click: () => { mainWindow.webContents.openDevTools({ mode: 'detach' }); }
  }));
  menu.popup({ window: mainWindow });
});

ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) { mainWindow.unmaximize(); }
    else { mainWindow.maximize(); }
  }
});
ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });

ipcMain.on('close-app', () => { app.quit(); });
autoUpdater.on('update-available', () => { dialog.showMessageBox({ type: 'info', title: 'アップデート', message: '新しいバージョンをダウンロードしています' }); });
autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({ type: 'question', buttons: ['今すぐ再起動', 'あとで'], defaultId: 0, message: 'アップデートが完了しました。再起動しますか？' }).then(result => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});
autoUpdater.on('error', error => { console.error('Updater Error:', error); });

app.whenReady().then(() => {
  HISTORY_FILE = path.join(app.getPath('userData'), 'history.json');
  ensureFile(HISTORY_FILE, []);

  BOOKMARKS_FILE = path.join(app.getPath('userData'), 'bookmarks.json');
  ensureFile(BOOKMARKS_FILE, []);

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('web-contents-created', (event, contents) => { contents.setWindowOpenHandler(() => ({ action: 'deny' })); });
