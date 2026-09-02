# host bundle 魔改手册（宿主升级重建指引）

> 版本：hana-downloader v0.11.0 · 宿主 0.814.0
> 目的：记录 host bundle 的全部魔改点 + 备份/恢复/升级重建方法。宿主升级或重装后会丢失魔改，按本文重建。
> 关联：`docs/v0.11.0-真同步投递完整机制.md`（投递机制全链路）、`docs/six-quadrant-test.md`（六象限回归）

---

## 1. 为什么必须魔改 host bundle

宿主（HanaAgent server）的 bundle 里有两大能力**没有向 v1 插件契约暴露**：

1. **`sessionHooks` registry**（宿主内置的 provider hooks 注册表）——v1 插件无法注册 `agent/pre-step` adjudicator。没有它，插件无法在"agent 每次 LLM API 请求前"注入 HBR（真同步投递的核心）。
2. **session 实时 streaming 状态**——v1 插件拿不到 `session.isStreaming`，投递层无法判断"agent 是否还在跑长任务"，只能用固定 SYNC_WAIT_MS 超时兜底（会误杀长任务）。

**不魔改的后果**：插件静默降级为纯异步 triggerTurn 投递（真同步失效），且长任务（>30s 无 API）会被固定超时误降级。**魔改是 v0.11.0 真同步 + 主动投递的必要前提。**

---

## 2. 魔改点（2 处，都在 `bundle/index.js`）

宿主 bundle 路径：
```
C:\Users\John Galt\.hanako\artifacts\server\0.814.0-win32-x64\bundle\index.js
```

### 魔改点 1：暴露 `sessionHooks` registry（L171120 附近）

原始代码：
```js
const j = e.sessionHooks ?? SLe();
globalThis.__sessionHooks = j;
```

**保持原样**——这行已在（`globalThis.__sessionHooks = j` 是宿主原有的，暴露了 hooks registry）。插件 `index.js onload` 通过 `globalThis.__sessionHooks.onDecision("agent/pre-step", injectVersion, {...})` 注册真同步注入版 adjudicator。

> ⚠️ 早期版本这行是**手动加的魔改**；0.814.0 宿主源码自带。若升级后该行消失（宿主不再暴露），需手动补：
> ```js
> globalThis.__sessionHooks = j;
> ```

### 魔改点 2：暴露 session 实时活跃态（紧跟在 L171120 之后，**手动加的魔改**）

```js
// 【魔改·主动投递】暴露 session 实时活跃态：判断 agent 是否还在 streaming（跑长任务/工具挂起）。
globalThis.__sessionHooks.isSessionActive = (sessionPath) => {
  try {
    return typeof Z.isSessionStreaming == "function" && Z.isSessionStreaming(sessionPath) === true;
  } catch { return false; }
};
```

- `Z` = host engine（本次魔改所在作用域内的引擎对象，有 `getSessionCoordinator`/`isSessionStreaming` 等方法）
- 用 `Z.isSessionStreaming(sessionPath)`（比 `Z.getSessionCoordinator()._getSessionEntryByPath(...).session.isStreaming` 更可靠——它额外检查 `prePromptAbortControllers`，且是公开方法）
- 插件 `lib/delivery.js` 的 `sessionActive()` 调它，判断 agent 活跃则 `RESCHEDULE` 续等、收束则兜底

---

## 3. 备份与恢复

### 备份（改动前必做）

```powershell
$bundle = "C:\Users\John Galt\.hanako\artifacts\server\0.814.0-win32-x64\bundle\index.js"
Copy-Item $bundle "D:\HanakoWorks\_temp\bundle-index.js.0.814.0-魔改前.bak" -Force
```

当前备份：`D:\HanakoWorks\_temp\bundle-index.js.0.814.0-魔改前.bak`（~8.4 MB）。

### 恢复（撤销魔改）

```powershell
Copy-Item "D:\HanakoWorks\_temp\bundle-index.js.0.814.0-魔改前.bak" `
          "C:\Users\John Galt\.hanako\artifacts\server\0.814.0-win32-x64\bundle\index.js" -Force
# 然后重启宿主
pwsh -File D:\HanakoWorks\_tools\restart-hana\restart-hana-reliable.ps1
```

---

## 4. 宿主升级后如何重建魔改

**宿主升级 / 重装会覆盖 bundle，魔改丢失。** 重建步骤：

1. **确认魔改点没了**：搜 `globalThis.__sessionHooks.isSessionActive`——若无，说明魔改丢失。
2. **定位新版本 bundle 的 sessionHooks 行**：搜 `globalThis.__sessionHooks = j` 或 `sessionHooks ??`，找到 engine 作用域的新行号。
3. **加魔改点 2**：在该行后插入 `isSessionActive` 定义（见 §2）。注意 `Z` 变量名可能变（新版本可能是别的 engine 变量名），确认 engine 对象有 `isSessionStreaming`。
4. **重启宿主**：`pwsh -File D:\HanakoWorks\_tools\restart-hana\restart-hana-reliable.ps1`
5. **验证**：看插件日志 `plugin_dev_diagnostics` 是否出现 `RESCHEDULE` / `INJECT`（主动投递 + 真同步生效）。

---

## 5. 魔改失效的症状与排查

| 症状 | 根因 | 排查 |
|---|---|---|
| 插件日志只有 `SYNC TIMEOUT ... → fallback`，无 `RESCHEDULE` | `isSessionActive` 魔改丢失 / `Z.isSessionStreaming` 不存在 | 确认魔改点 2 在 + 引擎对象名正确 |
| 无 `INJECT ... into next provider request` | `onDecision` 注册失败（`sessionHooks` 未暴露）| 确认魔改点 1 在 + `globalThis.__sessionHooks` 是 object |
| 插件 onload 日志 `sessionHooks=undefined` | bundle 未暴露 registry | 补魔改点 1 |
| 真同步失效（只能异步）| 魔改全丢 | 按 §4 重建 |

---

## 6. 关键常量（投递层依赖）

| 常量 | 值 | 说明 |
|---|---|---|
| `SYNC_WAIT_MS` | 30000 | enqueueSync 首轮等待（短于 agent 下一轮调用间隔会误杀）|
| `SYNC_MAX_WAIT_MS` | 10min | 主动投递续等总上限（防悬挂工具永不出结果）|
| `isSessionActive` | bundle 魔改暴露 | 判断 agent 是否还在 streaming |

---

## 7. 注意事项

- **魔改是运行时配置，不进 git**。`bundle/index.js` 是宿主产物，改了不回仓库。
- **宿主升级必失效**——本文是重建依据，升级后照 §4 重建。
- 备份保留在 `D:\HanakoWorks\_temp\`（本地，勿删，作为恢复快照）。
