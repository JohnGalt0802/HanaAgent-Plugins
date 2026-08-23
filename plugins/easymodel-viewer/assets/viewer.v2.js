// EasyModel 渲染核心（Hana 插件版 v2.0）
// - 多格式渲染（STL/OBJ/PLY/GLB/GLTF/3MF/STEP/IGES）
// - 单一 widget 入口：作为卡片在工作台任意位置摆放（v2.0 移除 right/center 二选一）
// - 打开文件夹：加载首个模型 + 后台扫描目录 + 横向可滚动缩略图预览条
// - 多文件工作集：◀▶ 切换 + 预览条点选

// ---------- Hana iframe host 协议（轻量，无 SDK 依赖） ----------
const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
let seq = 0;
function targetOrigin() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("hana-host-origin");
  if (explicit) return explicit;
  try { return new URL(document.referrer).origin; } catch { return "*"; }
}
function post(message) { window.parent.postMessage(message, targetOrigin()); }
function event(type, payload) { post({ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload }); }
function request(type, payload, timeoutMs = 15000) {
  const id = `hana-plugin-${Date.now()}-${++seq}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${type}`));
    }, timeoutMs);
    function onMessage(evt) {
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${type}`));
      else resolve(msg.payload);
    }
    window.addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}
function currentPluginId() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || "");
  if (!match) throw new Error("iframe route must be under /api/plugins/:pluginId/");
  return decodeURIComponent(match[1]);
}
function pluginApiUrl(path) {
  const stripped = String(path).replace(/^\/+/, "");
  return `${window.location.origin}/api/plugins/${encodeURIComponent(currentPluginId())}/${stripped}`;
}
function pluginApiFetch(path, init = {}) {
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  const headers = new Headers(init.headers || {});
  if (surfaceSession) headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
  return fetch(pluginApiUrl(path), { ...init, headers });
}
const hana = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  api: { url: pluginApiUrl, fetch: pluginApiFetch },
  toast: { show: (input) => request("toast.show", typeof input === "string" ? { message: input } : input) },
  resources: { pick: (input = {}) => request("resource.pick", input) },
};

window.addEventListener("error", function (e) {
  try {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;top:6px;left:6px;z-index:99999;background:#8B2C1F;color:#fff;font:11px/1.5 monospace;padding:6px 10px;border-radius:6px;max-width:80vw;white-space:pre-wrap";
    d.textContent = "JS-ERROR: " + (e.message || "") + " @ " + (e.filename || "").split("/").pop() + ":" + (e.lineno || "");
    document.body.appendChild(d);
  } catch (_x) {}
});

// ---------- three.js（UMD 全局版：传统 script 加载，兼容任何 Electron 内核） ----------
// 注意：不声明 const THREE（全局 const 会造成 TDZ，使先执行的 loaders 顶层 THREE.xxx 赋值报错），
// 全部通过 window.THREE 访问。
if (!window.THREE) {
  try {
    window.__EM_DIAG = window.__EM_DIAG || {};
    window.__EM_DIAG.threeMissing = true;
    var _err3 = document.createElement('div');
    _err3.style.cssText = 'position:fixed;top:6px;left:6px;z-index:99999;background:#8B2C1F;color:#fff;font:12px monospace;padding:8px;border-radius:6px';
    _err3.textContent = 'THREE 未加载（three.min.js 加载失败）';
    document.body.appendChild(_err3);
  } catch (_e) {}
}

// 诊断标记（探针上报用）
window.__EM_DIAG = window.__EM_DIAG || {};
window.__EM_DIAG.viewerLoaded = true;
window.__EM_DIAG.threeRev = (window.THREE && window.THREE.REVISION) || '';

// ---------- 工具 ----------
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function baseName(p) {
  return String(p).split(/[\\/]/).pop() || p;
}
function extOf(name) {
  const i = String(name).lastIndexOf(".");
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : "";
}

// ---------- 主入口：直接初始化渲染器 ----------
let container, scene, camera, renderer, controls, modelGroup, gridGroup;
let current = null;
let isWire = false;
let autoRotate = false;
let modelBox = null;
let gridUnit = 1;
let axesLines = null;
let isOrtho = false;
let dirLight = null;

const DEFAULT_FOV = 2 * Math.atan(12 / 50) * 180 / Math.PI; // 50mm 等效焦距 ≈27°

function fmtUnit(mm) {
  if (mm < 0.01) return '0.01mm';
  if (mm < 1) return (Math.round(mm * 100) / 100) + 'mm';
  if (mm < 10) return mm + 'mm';
  if (mm < 1000) return (mm / 10) + 'cm';
  return (mm / 1000) + 'm';
}

function status(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg || "";
}

function makeGrids() {
  while (gridGroup.children.length) {
    const g = gridGroup.children.pop();
    g.geometry.dispose();
    g.material.dispose();
  }
  if (!current) return;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(current);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);
  let unit = Math.pow(10, Math.floor(Math.log10(Math.max(maxDim / 10, 1e-4))));
  while (maxDim / unit > 20) unit *= 10;
  while (maxDim / unit < 8) unit /= 10;
  gridUnit = unit;

  const majorStep = unit * 10;
  const sx = Math.max(unit, Math.ceil(size.x / unit) * unit);
  const sy = Math.max(unit, Math.ceil(size.y / unit) * unit);
  const sz = Math.max(unit, Math.ceil(size.z / unit) * unit);
  const light = document.body.classList.contains('light');
  const PAL = light
    ? { fine: 0xdcd7ca, fineO: 0.55, major: 0x8f8578, majorO: 0.75 }
    : { fine: 0x8aa8c4, fineO: 0.4, major: 0xc0d8ee, majorO: 0.55 };

  const fineVerts = [];
  const L = (a, b) => { fineVerts.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
  const nX = Math.round(sx / unit), nY = Math.round(sy / unit), nZ = Math.round(sz / unit);
  for (let k = 1; k < nX; k++) { L([k * unit, 0, 0], [k * unit, 0, sz]); L([k * unit, 0, 0], [k * unit, sy, 0]); }
  for (let k = 1; k < nY; k++) { L([0, k * unit, 0], [0, k * unit, sz]); L([0, k * unit, 0], [sx, k * unit, 0]); }
  for (let k = 1; k < nZ; k++) { L([0, 0, k * unit], [sx, 0, k * unit]); L([0, 0, k * unit], [0, sy, k * unit]); }
  const fineGeo = new THREE.BufferGeometry();
  fineGeo.setAttribute('position', new THREE.Float32BufferAttribute(fineVerts, 3));
  const fineMat = new THREE.LineBasicMaterial({ color: PAL.fine, transparent: true, opacity: PAL.fineO });
  gridGroup.add(new THREE.LineSegments(fineGeo, fineMat));

  const majorVerts = [];
  const M = (a, b) => { majorVerts.push(a[0], a[1], a[2], b[0], b[1], b[2]); };
  for (let k = majorStep; k < sx; k += majorStep) { M([k, 0, 0], [k, 0, sz]); M([k, 0, 0], [k, sy, 0]); }
  for (let k = majorStep; k < sy; k += majorStep) { M([0, k, 0], [0, k, sz]); M([0, k, 0], [sx, k, 0]); }
  for (let k = majorStep; k < sz; k += majorStep) { M([0, 0, k], [sx, 0, k]); M([0, 0, k], [0, sy, k]); }
  const majorGeo = new THREE.BufferGeometry();
  majorGeo.setAttribute('position', new THREE.Float32BufferAttribute(majorVerts, 3));
  const majorMat = new THREE.LineBasicMaterial({ color: PAL.major, transparent: true, opacity: PAL.majorO });
  gridGroup.add(new THREE.LineSegments(majorGeo, majorMat));

  if (axesLines) {
    axesLines.forEach((l) => { modelGroup.remove(l); l.geometry.dispose(); l.material.dispose(); });
    axesLines = null;
  }
  const ox = -modelGroup.position.x, oy = -modelGroup.position.y, oz = -modelGroup.position.z;
  const mkAxis = (a, b, color) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([a[0], a[1], a[2], b[0], b[1], b[2]], 3));
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 });
    const l = new THREE.Line(g, m);
    modelGroup.add(l);
    return l;
  };
  axesLines = [
    mkAxis([ox, oy, oz], [ox + sx, oy, oz], 0xff5a5a),
    mkAxis([ox, oy, oz], [ox, oy + sy, oz], 0x5aff8a),
    mkAxis([ox, oy, oz], [ox, oy, oz + sz], 0x5ab2ff),
  ];
  gridGroup.position.set(ox, oy, oz);
}

function replaceObject(obj) {
  if (current) {
    modelGroup.remove(current);
    current.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => m.dispose());
      }
    });
  }
  current = obj;
  modelGroup.rotation.set(0, 0, 0);
  modelGroup.add(current);
}

function mount(name, unit) {
  autoRotate = false;
  const btnRotate = document.getElementById('btn-rotate');
  if (btnRotate) btnRotate.classList.remove('active');
  const hint = document.getElementById('hint');
  if (hint) hint.style.display = 'none';
  scene.updateMatrixWorld(true);
  const box0 = new THREE.Box3().setFromObject(current);
  current.position.x -= box0.min.x;
  current.position.y -= box0.min.y;
  current.position.z -= box0.min.z;
  const c0 = new THREE.Vector3();
  box0.getSize(c0);
  modelGroup.position.set(c0.x / 2, c0.y / 2, c0.z / 2);
  current.position.x -= c0.x / 2;
  current.position.y -= c0.y / 2;
  current.position.z -= c0.z / 2;
  scene.updateMatrixWorld(true);
  const chk = new THREE.Box3().setFromObject(current);
  if (Math.abs(chk.min.x) > 1e-6 || Math.abs(chk.min.y) > 1e-6 || Math.abs(chk.min.z) > 1e-6) {
    current.position.x -= chk.min.x;
    current.position.y -= chk.min.y;
    current.position.z -= chk.min.z;
    scene.updateMatrixWorld(true);
  }
  makeGrids();
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(current);
  const size = new THREE.Vector3();
  box.getSize(size);
  modelBox = box.clone();

  let faces = 0;
  current.traverse((c) => {
    if (c.geometry) {
      faces += c.geometry.index ? c.geometry.index.count / 3 : c.geometry.attributes.position.count / 3;
    }
  });
  const info = document.getElementById('info');
  if (info) {
    info.innerHTML =
      '<b>' + esc(name) + '</b><br>' +
      '三角面 ' + Math.round(faces).toLocaleString() + '<br>' +
      '尺寸 ' + size.x.toFixed(1) + ' × ' + size.y.toFixed(1) + ' × ' + size.z.toFixed(1) + '（' + unit + '）<br>' +
      '网格 ' + fmtUnit(gridUnit) + '/格';
  }
  document.title = name + ' — EasyModel';
  fitView();
}

function makeMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x9aa0a8, roughness: 0.32, metalness: 0.12, wireframe: isWire, // 默认灰色，色轮可调
  });
}

function mountGeometry(object, name, unit) {
  let root = object;
  if (object.isBufferGeometry) root = new THREE.Mesh(object, makeMaterial());
  const items = root.isGroup ? root.children : [root];
  items.forEach((c) => { if (c.geometry) c.geometry.computeVertexNormals(); });
  replaceObject(root);
  mount(name, unit);
}

function mountModel(object, name, unit) {
  replaceObject(object);
  mount(name, unit);
}

function cadToGroup(cad) {
  const group = new THREE.Group();
  (cad.meshes || []).forEach((m) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.attributes.position.array, 3));
    if (m.attributes.normal) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.attributes.normal.array, 3));
    else geo.computeVertexNormals();
    if (m.index) geo.setIndex(m.index.array);
    const c = m.color || [0.6, 0.63, 0.66];
    const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(c[0], c[1], c[2]), roughness: 0.4, metalness: 0.15 });
    if (m.color) mat.color.setHex(0x9aa0a8); // 初次加载统一灰色（色轮可调）
    group.add(new THREE.Mesh(geo, mat));
  });
  return group;
}

// ---------- 模型解析（服务端取数，path 场景） ----------
async function fetchModelObject(item) {
  const res = await pluginApiFetch('model?path=' + encodeURIComponent(item.path));
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || ('加载失败 ' + res.status));
  }
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    const cad = await res.json();
    if (cad.error) throw new Error(cad.error);
    return cadToGroup(cad);
  }
  const buf = await res.arrayBuffer();
  const ext = item.ext || extOf(item.path);
  if (ext === 'stl') return new THREE.Mesh(new THREE.STLLoader().parse(buf), makeMaterial());
  if (ext === 'obj') {
    const root = new THREE.OBJLoader().parse(new TextDecoder().decode(buf));
    const items = root.isGroup ? root.children : [root];
    items.forEach((c) => { if (c.geometry) c.geometry.computeVertexNormals(); });
    return root;
  }
  if (ext === 'ply') return new THREE.Mesh(new THREE.PLYLoader().parse(buf), makeMaterial());
  if (ext === 'glb' || ext === 'gltf') return new THREE.GLTFLoader().parse(buf, '').scene;
  if (ext === '3mf') return new THREE.ThreeMFLoader().parse(buf);
  throw new Error('不支持的格式: ' + ext);
}

async function loadByPath(filePath) {
  const item = { path: filePath, ext: extOf(filePath), name: baseName(filePath) };
  const info = document.getElementById('info');
  if (info) info.innerHTML = '<b>加载中…</b><br>' + esc(item.name);
  try {
    const obj = await fetchModelObject(item);
    mountModel(obj, item.name, 'mm');
    status('');
  } catch (err) {
    if (info) info.innerHTML = '<b>加载失败</b><br>' + esc((err && err.message) || err);
    status('加载失败');
  }
}

function loadFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      if (ext === 'stl') mountGeometry(new THREE.STLLoader().parse(e.target.result), file.name, '假定 mm');
      else if (ext === 'obj') mountGeometry(new THREE.OBJLoader().parse(new TextDecoder().decode(e.target.result)), file.name, '假定 mm');
      else if (ext === 'ply') mountGeometry(new THREE.PLYLoader().parse(e.target.result), file.name, '假定 mm');
      else if (ext === 'glb' || ext === 'gltf') mountModel(new THREE.GLTFLoader().parse(e.target.result, '').scene, file.name, 'mm');
      else if (ext === '3mf') mountModel(new THREE.ThreeMFLoader().parse(e.target.result), file.name, 'mm');
      else { const info = document.getElementById('info'); if (info) info.innerHTML = '<b>不支持该格式</b><br>' + esc(file.name); }
    } catch (err) {
      const info = document.getElementById('info');
      if (info) info.innerHTML = '<b>解析失败</b><br>' + esc((err && err.message) || err);
    }
  };
  reader.readAsArrayBuffer(file);
}

// ---------- SolidWorks 式小坐标轴（独立渲染器，左下角，点击正视） ----------
// 实现照搬桌面端（stl-viewer-app/index.html）：箭头固定世界 XYZ，场景随 modelGroup 旋转，
// 相机跟随主视角（up 同步 + 极点保护），点击 Raycaster 检测轴切换正视方向
let axisRenderer = null, axisScene = null, axisCamera = null;
let axisArrows = null; // { x, y, z } 箭头引用（Raycaster 用）
function initAxisGizmo() {
  if (axisRenderer || !container) return;
  axisScene = new THREE.Scene();
  axisCamera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  const _axisDir = new THREE.Vector3(0, 1, 0);
  const makeAxis = (dir, color) => {
    const group = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.72, 12), new THREE.MeshBasicMaterial({ color }));
    shaft.position.y = 0.36;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 16), new THREE.MeshBasicMaterial({ color }));
    cone.position.y = 0.72 + 0.14;
    group.add(shaft, cone);
    group.quaternion.setFromUnitVectors(_axisDir, dir);
    return group;
  };
  axisArrows = {
    x: makeAxis(new THREE.Vector3(1, 0, 0), 0xff5a5a),
    y: makeAxis(new THREE.Vector3(0, 1, 0), 0x5aff8a),
    z: makeAxis(new THREE.Vector3(0, 0, 1), 0x5ab2ff),
  };
  axisScene.add(axisArrows.x, axisArrows.y, axisArrows.z);
  axisRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  axisRenderer.setSize(84, 84);
  axisRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  axisRenderer.domElement.style.cssText = 'position:absolute;left:10px;bottom:10px;z-index:20;cursor:pointer';
  container.appendChild(axisRenderer.domElement);
  // 点击小轴：Raycaster 检测点中的轴 → 切换正视方向（与桌面端一致）
  axisRenderer.domElement.addEventListener('pointerdown', (e) => {
    const rect = axisRenderer.domElement.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const py = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(px, py), axisCamera);
    const hits = rc.intersectObjects([axisArrows.x, axisArrows.y, axisArrows.z], true);
    if (hits.length) {
      let arrow = hits[0].object;
      while (arrow && arrow !== axisArrows.x && arrow !== axisArrows.y && arrow !== axisArrows.z) arrow = arrow.parent;
      if (arrow === axisArrows.x) setFace('right');
      else if (arrow === axisArrows.y) setFace('top');
      else if (arrow === axisArrows.z) setFace('front');
    }
    e.preventDefault();
    e.stopPropagation();
  });
}

// ---------- 模型颜色（色板 + 色轮） ----------
let currentModelColor = null;
const SWATCH_COLORS = [0x8fd3d0, 0x4a90d9, 0x50c878, 0xffd54f, 0xff7043, 0xe5484d, 0x9b6de2, 0xf06292, 0x90a4ae, 0xb8a888, 0xf2f2f2, 0x2f3b4a];
function applyModelColor(hex) {
  if (!current) return;
  currentModelColor = hex;
  current.traverse((c) => {
    if (c.material) {
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      mats.forEach((m) => {
        if (m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshLambertMaterial) {
          m.color.setHex(hex);
        }
      });
    }
  });
}
function drawColorWheel(canvas) {
  const ctx = canvas.getContext('2d');
  const size = canvas.width, cx = size / 2, cy = size / 2, r = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > r) continue;
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      ctx.fillStyle = 'hsl(' + hue + ',' + Math.round(Math.min(dist / r, 1) * 100) + '%,50%)';
      ctx.fillRect(x, y, 1, 1);
    }
  }
}
function buildColorMenu() {
  const sw = document.querySelector('[data-swatches]');
  if (sw) {
    SWATCH_COLORS.forEach((hex) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.style.background = '#' + hex.toString(16).padStart(6, '0');
      b.title = '#' + hex.toString(16).padStart(6, '0');
      b.onclick = (e) => {
        e.stopPropagation();
        applyModelColor(hex);
        const menu = document.getElementById('color-menu');
        if (menu) menu.classList.remove('open');
      };
      sw.appendChild(b);
    });
  }
  const wheel = document.querySelector('[data-wheel]');
  if (wheel) drawColorWheel(wheel);
  const btn = document.getElementById('btn-color');
  const menu = document.getElementById('color-menu');
  if (btn && menu) {
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    };
    wheel.onclick = (e) => {
      // 单击选色，不退出（保持菜单打开继续调）；阻止冒泡防止 document 关闭菜单
      e.stopPropagation();
      const hex = pickWheelColor(e);
      if (hex !== null) applyModelColor(hex);
    };
    wheel.ondblclick = (e) => {
      // 双击选色并确认退出
      e.stopPropagation();
      const hex = pickWheelColor(e);
      if (hex !== null) applyModelColor(hex);
      menu.classList.remove('open');
    };
    function pickWheelColor(e) {
      const rect = wheel.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const size = wheel.width, cx = size / 2, cy = size / 2;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const r = size / 2 - 2;
      if (dist > r) return null;
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const sat = Math.min(dist / r, 1);
      return new THREE.Color().setHSL(hue / 360, sat, 0.5).getHex();
    }
  }
}

// ---------- 视角系统 ----------
const FACES = {
  front:  { d: [0, 0, 1], up: [0, 1, 0] },
  back:   { d: [0, 0, -1], up: [0, 1, 0] },
  left:   { d: [-1, 0, 0], up: [0, 1, 0] },
  right:  { d: [1, 0, 0], up: [0, 1, 0] },
  top:    { d: [0, 1, 0], up: [0, 0, -1] },
  bottom: { d: [0, -1, 0], up: [0, 0, 1] },
};

function updateProjection() {
  if (!current) return;
  if (isOrtho) {
    const box = new THREE.Box3().setFromObject(current);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
    const halfY = radius * 1.6;
    const halfX = halfY * camera.aspect;
    camera.projectionMatrix.makeOrthographic(-halfX, halfX, halfY, -halfY, 0.01, 100000);
  } else {
    camera.updateProjectionMatrix();
  }
}

function setProjection(type) {
  if (type === 'reset') { resetView(); return; }
  isOrtho = (type === 'ortho');
  document.querySelectorAll('#view-menu .dd-item[data-act]').forEach((b) => b.classList.toggle('cur', b.dataset.act === type));
  updateProjection();
}

function resetView() {
  if (!current) return;
  const box = new THREE.Box3().setFromObject(current);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.3;
  const d = 1 / Math.sqrt(3);
  camera.position.set(center.x + dist * d, center.y + dist * d, center.z + dist * d);
  camera.up.set(0, 1, 0);
  controls.target.copy(center);
  controls.update();
  updateProjection();
}

function setFace(face) {
  if (!current) return;
  const f = FACES[face];
  if (!f) return;
  const box = new THREE.Box3().setFromObject(current);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.3;
  camera.position.set(center.x + f.d[0] * dist, center.y + f.d[1] * dist, center.z + f.d[2] * dist);
  camera.up.set(f.up[0], f.up[1], f.up[2]);
  controls.target.copy(center);
  controls.update();
  updateProjection();
}

function fitBox(box) {
  if (!box) return;
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  camera.fov = DEFAULT_FOV;
  const dist = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.3;
  const d = 1 / Math.sqrt(3);
  camera.position.set(center.x + dist * d, center.y + dist * d, center.z + dist * d);
  camera.up.set(0, 1, 0);
  camera.near = Math.max(dist / 200, 1e-4);
  camera.far = dist * 200;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  updateProjection();
}

function fitView() {
  if (!current) return;
  fitBox(new THREE.Box3().setFromObject(current));
}

// ---------- 多文件工作集 ----------
const modelList = [];   // { type:'path'|'file', name, path?, ext, file? }
let currentIndex = -1;

function addModels(items, mode = 'replace') {
  if (mode === 'replace') modelList.length = 0;
  let added = 0;
  for (const it of items) {
    if (!it) continue;
    const path = it.path;
    if (path && modelList.some(m => m.path === path)) continue;
    modelList.push({
      type: it.type === 'file' ? 'file' : 'path',
      name: it.name || baseName(path || (it.file && it.file.name) || ''),
      path: path || '',
      ext: (it.ext || extOf(path || (it.file && it.file.name) || '')).toLowerCase(),
      file: it.file || null,
    });
    added++;
  }
  return added;
}

function updateNavState() {
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  if (prev) prev.disabled = currentIndex <= 0;
  if (next) next.disabled = currentIndex < 0 || currentIndex >= modelList.length - 1;
}

async function showModel(index) {
  if (index < 0 || index >= modelList.length) return;
  currentIndex = index;
  updateNavState();
  updatePreviewActive();
  const m = modelList[index];
  if (m.type === 'file') loadFile(m.file);
  else await loadByPath(m.path);
  status(modelList.length > 1 ? (index + 1) + ' / ' + modelList.length : '');
}

// ---------- 预览条（文件夹场景：横向可滚动缩略图） ----------
const strip = document.getElementById('preview-strip');
const previewCells = new Map();   // path -> cell DOM
let thumbQueue = [];
let thumbBusy = false;
let thumbRenderer = null, thumbScene = null, thumbCamera = null;

function ensureThumbRenderer() {
  if (thumbRenderer) return;
  // 透明背景：预览图底色由 .pv-thumb 的 CSS 控制，跟随皮肤即时生效
  thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(160, 120);
  thumbRenderer.setPixelRatio(1);
  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dl = new THREE.DirectionalLight(0xffffff, 1.15);
  dl.position.set(3, 4, 5);
  thumbScene.add(dl);
  thumbCamera = new THREE.PerspectiveCamera(42, 160 / 120, 0.1, 1e7);
}

async function renderThumb(m) {
  ensureThumbRenderer();
  // 清掉上一轮模型对象（保留灯光，否则无光照渲染黑图）
  for (let i = thumbScene.children.length - 1; i >= 0; i--) {
    const o = thumbScene.children[i];
    if (o.isLight) continue;
    thumbScene.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((mm) => mm.dispose());
    }
  }
  const obj = await fetchModelObject(m);
  // 预览图统一灰色模型（色轮可调），背景跟随皮肤（黑皮肤→黑底，白皮肤→亮底）
  obj.traverse((c) => {
    if (c.material && c.material.color) c.material.color.setHex(0x9aa0a8);
  });
  thumbScene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
  const dist = radius / Math.tan((42 * Math.PI) / 360) * 1.45;
  thumbCamera.position.set(center.x + dist * 0.8, center.y + dist * 0.7, center.z + dist);
  thumbCamera.up.set(0, 1, 0);
  thumbCamera.near = Math.max(dist / 200, 1e-4);
  thumbCamera.far = dist * 200;
  thumbCamera.lookAt(center);
  thumbCamera.updateProjectionMatrix();
  thumbRenderer.render(thumbScene, thumbCamera);
  return thumbRenderer.domElement.toDataURL('image/png');
}

function queueThumb(m) {
  thumbQueue.push(m);
  pumpThumbQueue();
}

async function pumpThumbQueue() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const m = thumbQueue.shift();
    const cell = previewCells.get(m.path);
    if (!cell) continue;
    try {
      const url = await renderThumb(m);
      const img = cell.querySelector('img');
      const spin = cell.querySelector('.pv-spin');
      if (img) { img.src = url; img.style.display = 'block'; }
      if (spin) spin.style.display = 'none';
    } catch (_e) {
      cell.classList.add('failed');
      const spin = cell.querySelector('.pv-spin');
      if (spin) spin.textContent = '×';
    }
    await new Promise((r) => setTimeout(r, 0)); // yield，避免卡 UI
  }
  thumbBusy = false;
}

function buildPreviewStrip() {
  strip.innerHTML = '';
  previewCells.clear();
  if (modelList.length < 2) {
    strip.hidden = true;
    return;
  }
  modelList.forEach((m, i) => {
    const cell = document.createElement('div');
    cell.className = 'pv-item' + (i === currentIndex ? ' active' : '');
    cell.dataset.index = String(i);
    if (m.type === 'file') {
      cell.innerHTML = '<div class="pv-thumb"><span class="pv-spin">' + esc(m.ext || '?') + '</span></div><div class="pv-name" title="' + esc(m.name) + '">' + esc(m.name) + '</div>';
    } else {
      cell.innerHTML = '<div class="pv-thumb"><span class="pv-spin">…</span><img style="display:none" alt=""></div><div class="pv-name" title="' + esc(m.name) + '">' + esc(m.name) + '</div>';
    }
    cell.onclick = () => showModel(i);
    strip.appendChild(cell);
    if (m.path) previewCells.set(m.path, cell);
  });
  strip.hidden = false;
  // 后台生成缩略图（只对 path 条目）
  modelList.forEach((m) => { if (m.type === 'path') queueThumb(m); });
}

function updatePreviewActive() {
  if (!strip || strip.hidden) return;
  strip.querySelectorAll('.pv-item').forEach((el, i) => el.classList.toggle('active', i === currentIndex));
}

// ---------- 打开文件夹 ----------
async function openFolder(dir) {
  status('扫描目录…');
  let data;
  try {
    const res = await pluginApiFetch('scan?dir=' + encodeURIComponent(dir));
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || ('扫描失败 ' + res.status));
    }
    data = await res.json();
  } catch (err) {
    status('目录扫描失败: ' + ((err && err.message) || err));
    return;
  }
  if (!data.files || !data.files.length) {
    status('该文件夹内没有可读取的模型');
    return;
  }
  const added = addModels(data.files.map((f) => ({ type: 'path', name: f.name, path: f.path, ext: f.ext })), 'replace');
  if (!added) { status('没有新模型'); return; }
  buildPreviewStrip();
  await showModel(0);
  status('已加载 ' + modelList.length + ' 个模型，后台生成预览…');
}

// ---------- 交互绑定 ----------
function bindEvents() {
  document.getElementById('btn-pick').onclick = async () => {
    try {
      const picked = await hana.resources.pick();
      const p = (picked && (picked.path || picked.filePath))
        || (picked && picked.resources && picked.resources[0] && (picked.resources[0].path || picked.resources[0].filePath));
      if (p) {
        const added = addModels([{ type: 'path', name: baseName(p), path: p, ext: extOf(p) }], 'replace');
        if (added) { buildPreviewStrip(); await showModel(0); }
      } else if (picked && picked.fileId) {
        hana.toast.show('请把文件拖进对话再打开');
      }
    } catch (_e) { /* user cancelled */ }
  };

  document.getElementById('btn-folder').onclick = async () => {
    try {
      const picked = await hana.resources.pick({ mode: 'directory' });
      const res = picked && picked.resources && picked.resources[0];
      const dir = res && (res.path || res.filePath);
      if (dir) await openFolder(dir);
    } catch (_e) { /* user cancelled */ }
  };

  const fileInput = document.getElementById('file-input');
  fileInput.onchange = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const added = addModels(files.map((f) => ({ type: 'file', name: f.name, file: f })), 'replace');
    if (!added) return;
    buildPreviewStrip();
    showModel(0);
  };

  document.getElementById('btn-wire').onclick = (e) => {
    isWire = !isWire;
    e.target.classList.toggle('active', isWire);
    if (current) {
      current.traverse((c) => { if (c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => { m.wireframe = isWire; });
      } });
    }
  };
  document.getElementById('btn-rotate').onclick = (e) => {
    autoRotate = !autoRotate;
    e.target.classList.toggle('active', autoRotate);
  };
  document.getElementById('btn-grid').onclick = (e) => {
    gridGroup.visible = !gridGroup.visible;
    e.target.classList.toggle('active', !gridGroup.visible);
  };
  document.getElementById('btn-fit').onclick = (e) => {
    e.stopPropagation();
    document.getElementById('view-menu').classList.toggle('open');
  };
  document.querySelectorAll('#view-menu .dd-item').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      if (b.dataset.act) setProjection(b.dataset.act);
      if (b.dataset.face) setFace(b.dataset.face);
      document.getElementById('view-menu').classList.remove('open');
    };
  });
  document.addEventListener('click', () => {
    document.getElementById('view-menu').classList.remove('open');
    const cm = document.getElementById('color-menu');
    if (cm) cm.classList.remove('open');
  });
  document.getElementById('btn-theme').onclick = () => {
    document.body.classList.toggle('light');
    if (current) makeGrids();
  };
  document.getElementById('btn-light').onclick = (e) => {
    dirLight.position.copy(camera.position);
    dirLight.target.position.copy(controls.target);
    dirLight.target.updateMatrixWorld();
    e.target.classList.add('active');
    document.getElementById('btn-light-def').classList.remove('active');
  };
  document.getElementById('btn-light-def').onclick = (e) => {
    dirLight.position.set(6, 10, 6);
    dirLight.target.position.set(0, 0, 0);
    dirLight.target.updateMatrixWorld();
    e.target.classList.add('active');
    document.getElementById('btn-light').classList.remove('active');
  };

  document.getElementById('btn-prev').onclick = () => showModel(currentIndex - 1);
  document.getElementById('btn-next').onclick = () => showModel(currentIndex + 1);

  // 空格选视角 + Esc
  const faceModal = document.getElementById('face-modal');
  document.querySelectorAll('.face-btn').forEach((b) => {
    b.onclick = () => { setFace(b.dataset.face); faceModal.style.display = 'none'; };
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      faceModal.style.display = (faceModal.style.display === 'flex') ? 'none' : 'flex';
    } else if (e.key === 'Escape') {
      faceModal.style.display = 'none';
      document.getElementById('view-menu').classList.remove('open');
    }
  });

  // 正交滚轮缩放（capture 截获，防 Arcball 双处理；预览条内滚轮交给条自身横向滚动）
  window.addEventListener('wheel', (e) => {
    if (e.target && e.target.closest && e.target.closest('#preview-strip')) return;
    if (!isOrtho || !current) return;
    e.stopPropagation();
    const invHalfX = Math.abs(camera.projectionMatrix.elements[0]);
    if (!isFinite(invHalfX) || invHalfX <= 0) return;
    const halfX = 1 / invHalfX;
    const aspect = camera.aspect;
    const halfY = halfX / aspect;
    const box = new THREE.Box3().setFromObject(current);
    const size = new THREE.Vector3();
    box.getSize(size);
    const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
    const targetY = Math.max(radius * 0.01, Math.min(radius * 100, halfY * (1 + Math.sign(e.deltaY) * 0.1)));
    const targetX = targetY * aspect;
    camera.projectionMatrix.makeOrthographic(-targetX, targetX, targetY, -targetY, 0.01, 100000);
  }, { capture: true, passive: true });

  // 预览条：鼠标停在条内滚轮左右滑动
  strip.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    strip.scrollLeft += e.deltaY;
  }, { passive: false });

  // 拖拽文件（浏览器级）
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const added = addModels(files.map((f) => ({ type: 'file', name: f.name, file: f })), 'replace');
    if (!added) return;
    buildPreviewStrip();
    showModel(0);
  });
}

// ---------- 自适应 + 循环 ----------
function resize() {
  if (!container) return;
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  if (isOrtho) updateProjection();
  else camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  if (autoRotate) modelGroup.rotation.y += 0.012;
  if (modelBox) {
    const t = controls.target;
    let changed = false;
    if (t.x < modelBox.min.x) { t.x = modelBox.min.x; changed = true; }
    else if (t.x > modelBox.max.x) { t.x = modelBox.max.x; changed = true; }
    if (t.y < modelBox.min.y) { t.y = modelBox.min.y; changed = true; }
    else if (t.y > modelBox.max.y) { t.y = modelBox.max.y; changed = true; }
    if (t.z < modelBox.min.z) { t.z = modelBox.min.z; changed = true; }
    else if (t.z > modelBox.max.z) { t.z = modelBox.max.z; changed = true; }
    if (changed) controls.update();
  }
  controls.update();
  renderer.render(scene, camera);
  // SolidWorks 式小坐标轴（照搬桌面端）：场景随 modelGroup 旋转，相机跟随主视角，原点钉在画布中心
  if (axisRenderer && axisCamera) {
    const _gDir = new THREE.Vector3(0, 0, 1).applyQuaternion(camera.quaternion);
    axisCamera.position.copy(_gDir).multiplyScalar(4.0);
    axisCamera.up.copy(camera.up);
    if (Math.abs(axisCamera.up.dot(_gDir)) > 0.99) axisCamera.up.set(0, 1, 0);
    axisCamera.lookAt(0, 0, 0);
    if (axisScene && modelGroup) axisScene.quaternion.copy(modelGroup.quaternion);
    axisRenderer.render(axisScene, axisCamera);
  }
}

// ---------- 初始化 ----------
async function main() {
  window.__EM_DIAG.mainStart = true;

  container = document.getElementById('viewer');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(DEFAULT_FOV, 1, 0.1, 5000);
  camera.position.set(8, 6, 10);
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  window.__EM_DIAG.rendererCreated = true;

  // 预编译常用材质 shader
  (function precompile() {
    const probeMat = new THREE.MeshStandardMaterial({ color: 0x8fd3d0, roughness: 0.32, metalness: 0.12 });
    const probeMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), probeMat);
    scene.add(probeMesh);
    renderer.compile(scene, camera);
    scene.remove(probeMesh);
    probeMat.dispose(); probeMesh.geometry.dispose();
  })();

  // ArcballControls：球面自由旋转，无万向锁死区（SolidWorks 式）
  controls = new THREE.ArcballControls(camera, renderer.domElement, scene);
  controls.setGizmosVisible(false);
  controls.dampingFactor = 25;

  scene.add(new THREE.AmbientLight(0xffffff, 0.28));
  scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x0a1220, 0.72));
  dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(6, 10, 6);
  scene.add(dirLight);

  // 三维自适应网格
  gridGroup = new THREE.Group();
  modelGroup = new THREE.Group();
  modelGroup.add(gridGroup);
  scene.add(modelGroup);

  makeGrids(); // 有模型时随尺寸自适应（空场景不画网格，保持干净等待界面）
  initAxisGizmo(); // 右上角小坐标轴（独立渲染器，随主相机旋转）
  buildColorMenu(); // 颜色选择器（色板 + 色轮）
  bindEvents();
  window.__EM_DIAG.eventsBound = true;
  // 自适应 + 循环
  window.addEventListener('resize', resize);
  resize();
  animate();

  hana.ready();
  hana.ui.resize({ height: document.body.scrollHeight || 600 });
  window.__EM_DIAG.ready = true;

  const fileParam = document.body.dataset.file || '';
  if (fileParam) {
    const added = addModels([{ type: 'path', name: baseName(fileParam), path: fileParam, ext: extOf(fileParam) }], 'replace');
    if (added) { buildPreviewStrip(); await showModel(0); }
  } else {
    const info = document.getElementById('info');
    if (info) info.innerHTML = '<b>打开一个模型文件</b><br>点「打开文件」「打开文件夹」或拖拽 STL/OBJ/PLY/GLB/3MF/STEP/IGES 进来';
  }
}

main().catch((e) => {
  try {
    const d = document.createElement("div");
    d.style.cssText = "position:fixed;top:6px;left:6px;z-index:99999;background:#8B2C1F;color:#fff;font:12px/1.6 monospace;padding:8px;border-radius:6px;max-width:80vw;white-space:pre-wrap";
    d.textContent = "INIT-FAIL: " + (e && e.message ? e.message : String(e));
    document.body.appendChild(d);
  } catch (_x) {}
});
