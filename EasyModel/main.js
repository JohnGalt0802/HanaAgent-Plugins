// 主进程：窗口 + 自定义协议 + 目录扫描 + CAD 格式解析（STEP/IGES）
const { app, BrowserWindow, protocol, net, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const MODEL_EXTS = ['.stl', '.obj', '.ply', '.glb', '.gltf', '.3mf', '.step', '.stp', '.iges', '.igs'];

// 日志文件写到 userData（打包后 app.asar 只读，不能写项目目录）
const LOG_FILE = path.join(app.getPath('userData'), 'console.log');
function logLine(s) {
  try { fs.appendFileSync(LOG_FILE, '[' + Date.now() + '] ' + s + '\n'); } catch { /* ignore */ }
}

// 在 app ready 之前注册协议特权：standard+secure+corsEnabled，
// 让页面能以 fetch/模块方式访问这两个自定义协议（解决跨源 CORS 拦截）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: 'stlview',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// 把任意 URL 读成字节并包装成带 CORS 头的 Response
async function corsResponse(url) {
  try {
    const res = await net.fetch(url);
    const body = await res.arrayBuffer();
    return new Response(body, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
      },
    });
  } catch (e) {
    return new Response('fetch error: ' + e.message, { status: 500 });
  }
}

// 从启动参数里找第一个存在的模型文件（双击文件关联时 Windows 会把它作为参数传进来）
function findModelArg(argv) {
  for (const a of argv) {
    if (typeof a === 'string' && MODEL_EXTS.includes(path.extname(a).toLowerCase()) && fs.existsSync(a)) return a;
  }
  return null;
}

// OpenCascade WASM 单例（首次调用时加载 7MB wasm，之后复用）
let occtPromise = null;
function getOCCT() {
  if (!occtPromise) occtPromise = require('occt-import-js')();
  return occtPromise;
}

// 深度优化：模块顶层立即启动 OCCT 预热（不等 app ready），
// WASM 加载与 Electron 启动完全并行，首个 STEP/IGES 解析时必然已就绪
getOCCT().catch(() => {});

function createWindow(initialFile) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    show: false, // 等页面就绪再显示，避免白屏闪烁
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 调试：渲染层 console 全量落盘（正式版保留无害）
  win.webContents.on('console-message', (e, level, message) => {
    logLine('[' + level + '] ' + message);
  });

  // 页面走自定义协议 app://bundle/，页面资源（含本地 three.js）同源加载，无 CORS
  const url = 'app://bundle/index.html' + (initialFile ? '?file=' + encodeURIComponent(initialFile) : '');
  win.loadURL(url);
  win.once('ready-to-show', () => win.show());
  attachTestHook(win);
}

// 自动化验证钩子（EASYMODEL_TEST=1 时主进程执行一轮功能自测，正式版保留无害）
function attachTestHook(win) {
  if (!process.env.EASYMODEL_TEST) return;
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const r = await win.webContents.executeJavaScript(`(async () => {
          const out = [];
          out.push('title=' + document.querySelector('.title').textContent);
          out.push('fov0=' + window.__em.camera.fov.toFixed(1));
          document.getElementById('btn-fit').click();
          out.push('menuOpen=' + document.getElementById('view-menu').classList.contains('open'));
          document.querySelector('#view-menu .dd-item[data-act="ortho"]').click();
          out.push('ortho=' + window.__em.isOrtho + ' e0=' + window.__em.camera.projectionMatrix.elements[0].toFixed(4));
          window.dispatchEvent(new WheelEvent('wheel', { deltaY: 300 }));
          out.push('zoomE0=' + window.__em.camera.projectionMatrix.elements[0].toFixed(4));
          document.getElementById('btn-fit').click();
          document.querySelector('#view-menu .dd-item[data-act="reset"]').click();
          out.push('resetFov=' + window.__em.camera.fov.toFixed(1) + ' ortho=' + window.__em.isOrtho);
          out.push('resetPos=' + window.__em.camera.position.x.toFixed(0) + ',' + window.__em.camera.position.y.toFixed(0) + ',' + window.__em.camera.position.z.toFixed(0));
          document.getElementById('btn-theme').click();
          out.push('light1=' + document.body.classList.contains('light'));
          document.getElementById('btn-theme').click();
          out.push('light2=' + document.body.classList.contains('light'));
          document.querySelector('#view-menu .dd-item[data-face="front"]').click();
          out.push('frontZ=' + window.__em.camera.position.z.toFixed(2) + ' upY=' + window.__em.camera.up.y);
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ' }));
          out.push('modal=' + document.getElementById('face-modal').style.display);
          document.querySelector('.face-btn[data-face="top"]').click();
          out.push('topY=' + window.__em.camera.position.y.toFixed(2) + ' closed=' + (document.getElementById('face-modal').style.display === 'none'));
          document.querySelector('#view-menu .dd-item[data-act="persp"]').click();
          out.push('persp=' + (!window.__em.isOrtho));
          document.getElementById('btn-rotate').click();
          out.push('rot=' + window.__em.rotating);
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));
          document.getElementById('btn-rotate').click();
          out.push('rot2=' + window.__em.rotating);
          document.getElementById('btn-rotate').click(); // 保持自转（供截图验证坐标轴跟随）
          const ctl = window.__em.controls;
          ctl.target.set(9999, 9999, 9999);
          await new Promise(r => requestAnimationFrame(r));
          await new Promise(r => requestAnimationFrame(r));
          out.push('clamp=' + ctl.target.x.toFixed(0) + ',' + ctl.target.y.toFixed(0) + ',' + ctl.target.z.toFixed(0));
          return out.join(' | ');
        })()`);
        logLine('[TEST] ' + r);
      } catch (err) {
        logLine('[TEST-ERR] ' + String(err && err.message || err));
      }
    }, 4000);
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  // 协议一：app://bundle/<path> 承载应用页面与本地资源（three.js 等）
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);
    const filePath = path.join(__dirname, p);
    const ok = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    try {
      logLine('[app://] ' + p + ' -> ' + ok);
    } catch { /* ignore */ }
    if (!ok) {
      return new Response('not found: ' + p, { status: 404 });
    }
    return corsResponse(pathToFileURL(filePath).toString());
  });

  // 协议二：stlview://file?p=<编码后的绝对路径> 加载任意位置的模型文件，绕开 CORS
  protocol.handle('stlview', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.searchParams.get('p') || '');
    if (!p || !fs.existsSync(p)) {
      return new Response('file not found: ' + p, { status: 404 });
    }
    return corsResponse(pathToFileURL(p).toString());
  });

  const initialFile = findModelArg(process.argv.slice(1));
  logLine('[argv] ' + JSON.stringify(process.argv) + ' -> initialFile=' + initialFile);
  createWindow(initialFile);
});

app.on('window-all-closed', () => app.quit());

// IPC：弹出系统「打开方式」对话框（用户选一次并勾选始终，即可永久设默认）
ipcMain.handle('open-as-dialog', (e, filePath) => {
  try {
    require('child_process').exec('rundll32 shell32.dll,OpenAs_RunDLL "' + filePath + '"');
    return { success: true };
  } catch (err) {
    return { success: false, error: String((err && err.message) || err) };
  }
});

// IPC：列出某文件同目录下所有支持的模型文件，返回当前文件索引（用于翻页）
ipcMain.handle('list-models', (e, currentPath) => {
  if (!currentPath || typeof currentPath !== 'string') return { files: [], index: -1 };
  const dir = path.dirname(currentPath);
  let names;
  try {
    names = fs.readdirSync(dir)
      .filter((f) => MODEL_EXTS.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 大小写敏感排序（大写在前）
  } catch {
    return { files: [], index: -1 };
  }
  const files = names.map((f) => path.join(dir, f));
  return { files, index: files.indexOf(currentPath) };
});

const MODEL_EXTS_SET = new Set(MODEL_EXTS); // 扩展名集合（扫描文件夹用）

// IPC：弹出系统文件夹选择框，扫描目录内所有支持的模型文件（打开文件夹功能）
ipcMain.handle('scan-folder', async () => {
  const { dialog } = require('electron');
  const win = BrowserWindow.getFocusedWindow();
  const opts = { properties: ['openDirectory'], title: '选择模型文件夹' };
  const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const dir = result.filePaths[0];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!MODEL_EXTS_SET.has(ext)) continue;
    const full = path.join(dir, e.name);
    files.push({ name: e.name, path: full, ext: ext.slice(1) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
  return { dir, files };
});

// IPC：解析 STEP/IGES 文件（按路径）
ipcMain.handle('parse-cad', async (e, filePath) => {
  try {
    const occt = await getOCCT();
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const params = { linearUnit: 'millimeter' };
    const result = (ext === '.iges' || ext === '.igs')
      ? occt.ReadIgesFile(content, params)
      : occt.ReadStepFile(content, params);
    return { success: !!result.success, result };
  } catch (err) {
    return { success: false, error: String((err && err.message) || err) };
  }
});

// IPC：解析 STEP/IGES 文件（拖拽/选择时按二进制内容）
ipcMain.handle('parse-cad-buffer', async (e, payload) => {
  try {
    const occt = await getOCCT();
    const ext = (payload.name.split('.').pop() || '').toLowerCase();
    const params = { linearUnit: 'millimeter' };
    const result = (ext === 'iges' || ext === 'igs')
      ? occt.ReadIgesFile(new Uint8Array(payload.buffer), params)
      : occt.ReadStepFile(new Uint8Array(payload.buffer), params);
    return { success: !!result.success, result };
  } catch (err) {
    return { success: false, error: String((err && err.message) || err) };
  }
});
