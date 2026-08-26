// 页面 + 模型数据路由（文件名 viewer.js → 前缀 /viewer）
//   GET /viewer              页面 shell（widget：单一入口）
//   GET /viewer/model        模型数据（网格格式→二进制；STEP/IGES→occt 解析 JSON）
//   GET /viewer/scan         目录扫描（打开文件夹 → 列出可读模型文件）
// v2.0：移除 right/center 二选一配置与 manifest 同步机制；改为单一 widget 入口，
//      宿主卡片化后位置由用户在 chalkboard 自由摆放。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// pluginDir: routes/ 上溯两级
function pluginDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.dirname(here);
}

const CAD_EXTS = ["step", "stp", "iges", "igs"];
const MODEL_EXTS = new Set(["stl", "obj", "ply", "glb", "gltf", "3mf", "step", "stp", "iges", "igs"]);
// 诊断上报缓冲（探针：页面执行状态 → POST /diag）
let diagBuffer = [];
function pushDiag(body) {
  diagBuffer.push({ t: Date.now(), ...body });
  if (diagBuffer.length > 50) diagBuffer.shift();
}

// ── 全内联资产构建 ──
// Hana 资产服务返回 CORP: same-origin，跨源 iframe（桌面端 UI origin ≠ 服务端 origin）
// 会静默拦截所有 assets 请求；因此 three/loaders/viewer 全部内联进 HTML，零外部依赖。
let inlineCache = null;
let inlineCacheKey = "";
function buildInlineJs() {
  const dir = path.join(pluginDir(), "assets");
  const files = [
    "vendor/legacy/three.min.js",
    "vendor/legacy/ArcballControls.js",
    "vendor/legacy/STLLoader.js",
    "vendor/legacy/OBJLoader.js",
    "vendor/legacy/PLYLoader.js",
    "vendor/legacy/GLTFLoader.js",
    "vendor/legacy/3MFLoader.js",
    "viewer.v2.js",
  ];
  let key = "";
  for (const f of files) {
    try { key += fs.statSync(path.join(dir, f)).mtimeMs + ";"; } catch { key += "0;"; }
  }
  if (inlineCache && key === inlineCacheKey) return inlineCache;
  const parts = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  inlineCache = parts.join("\n;\n");
  inlineCacheKey = key;
  return inlineCache;
}
function escapeClosingScript(s) {
  return String(s).replace(/<\/script/gi, "<\\/script");
}

let occtPromise = null;
function getOCCT() {
  if (!occtPromise) occtPromise = require("occt-import-js")();
  return occtPromise;
}

export default function registerViewerRoutes(app, ctx) {
  // 插件 assets 兜底服务（相对路径请求可能不经 servePluginAsset，双保险）
  app.get("/assets/*", (c) => {
    const m = c.req.path.match(/(?:^|\/)assets\/(.+)$/);
    const rel = m ? m[1] : "";
    if (!rel || rel.includes("..")) return c.json({ error: "asset not found" }, 404);
    const file = path.join(pluginDir(), "assets", rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return c.json({ error: "asset not found: " + rel }, 404);
    }
    const types = {
      ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
      ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png",
      ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf"
    };
    const ct = types[path.extname(file).toLowerCase()] || "application/octet-stream";
    return new Response(new Uint8Array(fs.readFileSync(file)), {
      headers: { "Content-Type": ct, "Cache-Control": "no-store" },
    });
  });

  // ── 诊断上报（iframe 探针 POST；GET 读最近记录） ──
  app.post("/diag", async (c) => {
    try {
      const body = await c.req.json();
      pushDiag(body);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: String((e && e.message) || e) });
    }
  });
  app.get("/diag", (c) => c.json(diagBuffer));

  // ── 目录扫描：打开文件夹 → 列出文件夹内可读取模型（顶层） ──
  app.get("/scan", (c) => {
    const dir = c.req.query("dir") || "";
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return c.json({ error: "目录不存在: " + dir }, 404);
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return c.json({ error: "目录读取失败: " + String((err && err.message) || err) }, 500);
    }
    const files = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (!MODEL_EXTS.has(ext)) continue;
      const full = path.join(dir, e.name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* 忽略单个文件错误 */ }
      files.push({ name: e.name, path: full, size, ext });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, "zh", { numeric: true }));
    return c.json({ dir, count: files.length, files });
  });

  // ── 模型数据（先注册，避免被兜底拦截） ──
  app.get("/model", async (c) => {
    const p = c.req.query("path") || "";
    if (!p || !fs.existsSync(p)) return c.json({ error: "file not found: " + p }, 404);
    const ext = path.extname(p).toLowerCase().replace(".", "");
    if (CAD_EXTS.includes(ext)) {
      try {
        const occt = await getOCCT();
        const content = fs.readFileSync(p);
        const params = { linearUnit: "millimeter" };
        const result = (ext === "iges" || ext === "igs")
          ? occt.ReadIgesFile(content, params)
          : occt.ReadStepFile(content, params);
        if (!result.success) return c.json({ error: "解析失败: " + (result.error || "未知") }, 422);
        return c.json({ format: "cad", meshes: result.meshes || [] });
      } catch (err) {
        return c.json({ error: "CAD 解析异常: " + String((err && err.message) || err) }, 500);
      }
    }
    try {
      const buf = fs.readFileSync(p);
      return new Response(new Uint8Array(buf), {
        headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
      });
    } catch (err) {
      return c.json({ error: "读取失败: " + String((err && err.message) || err) }, 500);
    }
  });

  // ── 查看器 HTML（单一 widget 入口 /viewer） ──
  // 注意：HTML 必须 no-store，否则 Chromium 启发式缓存会让 iframe 拿到旧页面
  const shellHandler = async (c) => {
    c.header("Cache-Control", "no-store");
    return c.html(await renderShell(c, ctx));
  };
  app.get("/em", shellHandler);
  app.get("*", shellHandler);
}

async function renderShell(c, ctx) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
  const file = c.req.query("file") || "";
  // 单一 widget 入口：直接渲染查看器（v2.0 移除 right/center 二选一，
  // 宿主卡片化后位置由用户在 chalkboard 自由摆放）
  // importmap 在旧 Electron 内核不支持，且资产请求会被 CORP: same-origin 拦截，
  // 因此 three/loaders/viewer 全部内联，零外部依赖（与旧版 em-viewer.html 同思路）
  const inlineJs = escapeClosingScript(buildInlineJs());
  const assetBase = `assets`;
  let inlineCss = "";
  try {
    inlineCss = fs.readFileSync(path.join(pluginDir(), "assets", "viewer.css"), "utf8");
  } catch (e) { inlineCss = ""; }
  const title = "EasyModel 模型查看";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
  <style>${inlineCss}</style>
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-file="${escapeAttr(file)}">
  <div id="app">
    <div id="toolbar">
      <span class="title">EasyModel</span>
      <button type="button" class="btn" id="btn-pick">打开文件</button>
      <button type="button" class="btn" id="btn-folder">打开文件夹</button>
      <button type="button" class="btn" id="btn-wire" aria-pressed="false">线框</button>
      <button type="button" class="btn" id="btn-rotate" aria-pressed="false">自转</button>
      <button type="button" class="btn" id="btn-grid" aria-pressed="false">网格</button>
      <div class="dd" id="view-dd">
        <button type="button" class="btn" id="btn-fit">视角 ▾</button>
        <div class="dd-menu" id="view-menu">
          <button type="button" class="dd-item" data-act="reset">重置视角</button>
          <button type="button" class="dd-item" data-act="persp">persp</button>
          <button type="button" class="dd-item" data-act="ortho">正交</button>
          <div class="dd-sec">正视方向</div>
          <button type="button" class="dd-item" data-face="front">前视</button>
          <button type="button" class="dd-item" data-face="back">后视</button>
          <button type="button" class="dd-item" data-face="left">左视</button>
          <button type="button" class="dd-item" data-face="right">右视</button>
          <button type="button" class="dd-item" data-face="top">俯视</button>
          <button type="button" class="dd-item" data-face="bottom">仰视</button>
        </div>
      </div>
      <div class="dd" id="color-dd">
        <button type="button" class="btn" id="btn-color">颜色 ▾</button>
        <div class="dd-menu color-picker" id="color-menu">
          <div class="dd-label">预设颜色</div>
          <div class="swatches" data-swatches></div>
          <canvas class="cp-wheel" data-wheel width="82" height="82"></canvas>
        </div>
      </div>
      <button type="button" class="btn" id="btn-theme">换肤</button>
      <button type="button" class="btn" id="btn-light" aria-pressed="false">光源⇄视角</button>
      <button type="button" class="btn" id="btn-light-def" aria-pressed="false">光源复位</button>
    </div>
    <div id="preview-strip" data-preview-strip hidden></div>
    <div id="viewer">
      <button type="button" class="nav-btn nav-prev" id="btn-prev" title="上一个" disabled>◀</button>
      <button type="button" class="nav-btn nav-next" id="btn-next" title="下一个" disabled>▶</button>
      <div class="hint" id="hint">把 STL / OBJ / PLY / GLB / 3MF / STEP / IGES 拖到这里<br>或点「打开文件」「打开文件夹」</div>
      <div id="status" data-status></div>
    </div>
    <div id="info" data-info></div>
    <div id="face-modal" style="display:none">
      <div class="face-panel">
        <div class="face-title">选择视角 · Esc 关闭</div>
        <div class="face-grid">
          <button type="button" class="face-btn" data-face="front">前</button>
          <button type="button" class="face-btn" data-face="back">后</button>
          <button type="button" class="face-btn" data-face="left">左</button>
          <button type="button" class="face-btn" data-face="right">右</button>
          <button type="button" class="face-btn" data-face="top">上</button>
          <button type="button" class="face-btn" data-face="bottom">下</button>
        </div>
      </div>
    </div>
  </div>
  <input type="file" id="file-input" accept=".stl,.obj,.ply,.glb,.gltf,.3mf,.step,.stp,.iges,.igs" multiple style="display:none">
  <script>
  // ── 诊断探针：上报页面执行状态（viewer 各阶段写入 window.__EM_DIAG） ──
  window.__EM_DIAG = { stage: 'html', ts: Date.now(), href: location.href.slice(0, 200) };
  (function () {
    var s = new URLSearchParams(location.search).get('pluginSurfaceSession');
    var h = { 'Content-Type': 'application/json' };
    if (s) h['X-Hana-Plugin-Surface-Session'] = s;
    var report = function () {
      try {
        fetch('diag', { method: 'POST', headers: h, body: JSON.stringify(window.__EM_DIAG || {}) });
      } catch (e) {}
    };
    window.addEventListener('error', function (e) {
      try { window.__EM_DIAG.lastError = (e.message || '') + ' @' + ((e.lineno || '') + ':' + (e.colno || '')); } catch (_e) {}
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      try { window.__EM_DIAG.lastRejection = String((e.reason && e.reason.message) || e.reason || ''); } catch (_e) {}
    }, true);
    document.addEventListener('click', function () {
      try { window.__EM_DIAG.clicks = (window.__EM_DIAG.clicks || 0) + 1; } catch (_e) {}
    }, true);
    setTimeout(report, 1500);
    setTimeout(report, 5000);
    setTimeout(report, 12000);
  })();
  </script>
  <script>${inlineJs}</script>
  <script>
  (function () {
    function r() { try { parent.postMessage({ type: 'ready' }, '*'); } catch (e) {} }
    r();
    if (window.addEventListener) window.addEventListener('load', r);
    setTimeout(r, 1500);
    setTimeout(r, 4000);
  })();
  </script>
</body>
</html>`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
