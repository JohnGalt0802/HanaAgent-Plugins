# Hana 下载管理器 — 宿主主题跟随 patch 说明

> 适用版本：Hana **0.680.21**（及 0.680.x 相同主题机制）
> 目的：让插件卡片（聊天流 / Chalkboard）在宿主**切主题时自动跟随**，不残留旧主题高对比。
> **重要**：这是**宿主 renderer 文件**的 patch，Hana 升级会被覆盖，**升级后必须用本包脚本重打**。

---

## 一、为什么需要这个 patch

0.680.21 宿主切主题（`applyConcreteTheme`）时**只改宿主自己的** `html[data-theme]` + `<link id="themeSheet">` + body class，**完全不通知插件 iframe**：

- iframe 是**独立 Document**，构造时拿到的是当时主题的 CSS 变量**快照**，之后不再更新。
- 主题事件常量 `hana.theme.changed`（`plugin-card-iframe-registry`）**已注册但宿主无任何调用方**，payload 未定义、实际不发。
- 宿主**不重注** iframe 的 `--bg-card` / `--accent` / `--text` 等 CSS 变量。

**后果**：插件如果依赖 `var(--accent)`（宿主注入值）或静态 `data-hana-theme`，切主题后会拿到**旧主题值**（如切到暖纸仍残留青夜色），主题切换不彻底。

---

## 二、patch 内容（两层）

### 1) 宿主 `lib/theme.js`（两条 renderer 都要打）
在 `applyConcreteTheme`（minified 为 `N(e)`）设完 `data-theme` + `themeSheet.href` 后，追加：

```js
window.dispatchEvent(new CustomEvent("hana-theme-applied",{detail:e})),
(()=>{try{for(var k in window.frames){try{window.frames[k].postMessage({type:"hana.theme.changed",theme:e},"*")}catch(_){}}}catch(_){}})()
```

即：**广播事件** + **向宿主帧内所有 iframe postMessage** `hana.theme.changed`。

- 覆盖：聊天流 / 同一宿主文档内的插件 iframe。
- 局限：独立弹出的 Chalkboard 窗口（detached）不在 `window.frames`，暂不覆盖（如需另接 `ChalkboardCardCenter` 同步路径）。

### 2) 插件 `app/manager.js` + `app/card.js`
监听 `window message` 的 `hana.theme.changed` → 更新 `body[data-hana-theme]` + 重判 `t-dark`：

```js
window.addEventListener("message", function (ev) {
  var md = ev.data;
  if (!md || md.type !== "hana.theme.changed") return;
  var th = md.theme || "";
  if (!th) return;
  document.body.setAttribute("data-hana-theme", th);
  var dark = /dark|midnight|contrast|深/i.test(th);
  document.body.classList.toggle("t-dark", dark);
  if (typeof render === "function") { try { render(); } catch (e) {} }
});
```

### 3) 插件色板（manager.css / card.css）
**自包含两套 Hana 色板**（浅 warm-paper / 深 midnight），用 `t-dark` 判定切换，**不要依赖宿主注入的 `var(--accent)`/`var(--bg-card)`**（宿主不重注，切主题后是旧值）：

- 浅：`--mgr-bg:#FCFAF5; --mgr-accent:#537D96; --mgr-text:#3B3D3F; ...`
- 深（`body.t-dark`）：`--mgr-bg:#445560; --mgr-accent:#C99AAF; --mgr-text:#E1EAF0; ...`

---

## 三、重打步骤（Hana 升级后）

1. **备份确认**：升级前把本目录 `patch/` 保留（含本说明 + 脚本）。升级后若 renderer 被覆盖，`node --check` 验证 theme.js 无 `hana.theme.changed` 即需重打。
2. **打 theme.js**（自动备份 `.bak-patch`）：
   ```powershell
   node patch\patch-theme-0.680.21.js
   ```
   默认打两条 renderer；也可显式传路径。
3. **验证语法**：
   ```powershell
   node --check ~\.hanako\artifacts\renderer\0.680.21\lib\theme.js
   ```
4. **重启 hana-server**（让 theme.js + 插件加载）：
   ```powershell
   pwsh -File <你的重启脚本目录>\restart-hana\restart-hana-reliable.ps1
   ```
5. **插件侧确认**：`app/manager.js`、`app/card.js` 含 `hana.theme.changed` 监听；`manager.css`/`card.css` 为自包含两套色板。

---

## 四、验证（切主题跟随）

1. 打开一张下载管理器 / 下载进度卡片。
2. 宿主设置里切换主题（暖纸 ↔ 青夜）。
3. 卡片应在**切主题后自动变亮/变暗**（暖纸→白底深字；青夜→深底浅字），不再残留旧主题高对比。

---

## 五、文件清单

| 文件 | 改动 |
|------|------|
| `patch/patch-theme-0.680.21.js` | theme.js 打 patch 脚本（广播事件 + frames 通知） |
| `patch/README.md`（本文件） | patch 说明 |
| `app/manager.js` | 监听 `hana.theme.changed` → 更新 data-hana-theme + t-dark + render |
| `app/card.js` | 监听 `hana.theme.changed` → 更新 data-hana-theme + t-dark |
| `app/manager.css` | 自包含两套 Hana 色板（浅/深，t-dark 切换），不依赖宿主变量 |
| `app/card.css` | 自包含两套色板（同源） |

> 备份：`lib/theme.js.bak-patch`（打前自动生成）；插件 `.bak-native`（本地保留）。

---

## 六、为什么不 patch CardShell

探索证实 CardShell 插件 iframe（`RE` 组件，line 190）**无任何主题监听**，`ib`（iframe URL 构造）在不可读的 minified 单行内，**改 CardShell 重载 iframe 风险高且需动不可读代码**。本方案（theme.js 广播 frames + 插件监听 + 自包含色板）**不碰 CardShell**，改动可控、可重打、升级覆盖可恢复。
