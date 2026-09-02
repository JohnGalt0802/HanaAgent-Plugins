# notification-prompt-minimal — 投递提示词最小化优化方案

> 基于 `docs/notification-prompt-optimization.md` §5.1，但按用户要求收敛为**最小化**改动。  
> 当前 dev 源 `lib/delivery.js` 已回滚到 commit `537747bf`。  
> 本次只改 `buildResult` + `handleStall` 两处；**不改 `buildEntry`，不引入新 helper，不改其他文件**。

---

## §1 改动范围

| 位置 | 处理 |
|---|---|
| `lib/delivery.js` `buildResult(task)` | ✅ 只新增字段，不动 HBR 拼装、不动 JSON.stringify、不动现有 state 分支 |
| `lib/delivery.js` `handleStall(task)` 内 result 拼装 | ✅ 只同步新增字段 |
| `lib/delivery.js` `buildEntry(taskId, result)` | ❌ 完全不动，保持 `537747bf` 旧版 |
| `lib/dlcore.js` / `lib/deferred.js` / `extensions/*` / `index.js` | ❌ 完全不动 |
| 新增 helper / `formatElapsed` | ❌ 不新增 |

---

## §2 buildResult 的 unified diff

```diff
--- a/lib/delivery.js
+++ b/lib/delivery.js
@@ -89,16 +89,25 @@ function buildResult(task) {
 function buildResult(task) {
   const state = statusOf(task);
   const base = { type: "download", taskId: task.taskId, fileName: task.fileName || "", state, consumedByWait: false };
+  const status = state === "done" ? "done" : state === "canceled" ? "cancelled" : "error";
+  const timestamp = new Date(task.finishedAt || Date.now()).toISOString();
+  const elapsedMs = task.finishedAt && task.startedAt ? task.finishedAt - task.startedAt : null;
+  const elapsed = elapsedMs === null ? null : `${elapsedMs}ms`;
+  const action = status === "error" ? "decide" : "none";
+  const errorCode = String(task.error || "").match(/\b\d{3}\b/)?.[0] || null;
+  const meta = { source: "system", plugin: "download-progress", status, timestamp, elapsedMs, elapsed, action, errorCode };
   if (state === "done") {
-    return { ...base, filePath: task.filePath, total: task.total ?? null, received: task.received ?? 0 };
+    return { ...base, ...meta, filePath: task.filePath, total: task.total ?? null, received: task.received ?? 0 };
   }
   const userCanceled = state === "canceled" && task.canceledBy === "user";
   return {
     ...base,
+    ...meta,
     error: task.error || state,
     canceledBy: task.canceledBy || null,
     userCanceled,
    ...(userCanceled ? { hint: "用户手动取消（非故障，无需自动重试或换源）" } : {}),
    ...(task.filePath ? { filePath: task.filePath } : {}),
  };
 }
```

新增字段说明：

- `source: "system"`：明确这是系统后台通知。
- `plugin: "download-progress"`：明确来源插件。
- `status`：新语义 `done` / `error` / `cancelled`，与旧 `state` 解耦但保留旧 `state` 字段。
- `timestamp`：ISO 字符串，优先取 `task.finishedAt`，缺失时取当前时间。
- `elapsedMs`：`task.finishedAt - task.startedAt`，缺失为 `null`。
- `elapsed`：最小化拼为 `"${elapsedMs}ms"`，缺失为 `null`。
- `action`：`error` 为 `"decide"`，`done` / `cancelled` 为 `"none"`。
- `errorCode`：从 `task.error` 解析 HTTP 状态码，如 `HTTP 404 Not Found` → `"404"`，无法解析为 `null`。

---

## §3 handleStall 的 unified diff

```diff
--- a/lib/delivery.js
+++ b/lib/delivery.js
@@ -223,13 +223,21 @@ function handleStall(task) {
 
   const stallKey = taskId + ":stall:" + Date.now();
+  const now = Date.now();
   const result = {
     type: "download-stall",
     taskId,
     fileName: t.fileName || "",
     url: t.url || "",
     state: statusOf(t),
+    source: "system",
+    plugin: "download-progress",
+    status: "stall",
+    timestamp: new Date(now).toISOString(),
+    action: "decide",
+    elapsedMs: t.startedAt ? now - t.startedAt : null,
+    elapsed: t.startedAt ? `${now - t.startedAt}ms` : null,
     received: t.received || 0,
     total: t.total || 0,
     stalledAt: t.stalledAt || Date.now(),
     hint: `下载连接已停滞（${t.stallTimeoutMs}ms 无新数据）。请决策：继续等待 / 换源重下 / 取消任务。`,
   };
```

新增字段说明：

- `source: "system"`、`plugin: "download-progress"`：与终态通知同源标识。
- `status: "stall"`：明确这是停滞通知，不再让 `state: "running"` 造成歧义。
- `timestamp`：ISO 字符串，表示本次停滞通知生成时间。
- `action: "decide"`：明确需要 agent 决策。
- `elapsedMs`：`t.startedAt` → `Date.now()` 的毫秒数，缺失为 `null`。
- `elapsed`：最小化拼为 `"${now - t.startedAt}ms"`，缺失为 `null`。

---

## §4 buildEntry 保持不变（保持 537747bf 旧版）

当前 `lib/delivery.js` 中 `buildEntry` 保持如下，**不做任何修改**：

```js
function buildEntry(taskId, result) {
  const status = result.state === "done" ? "success" : result.state === "canceled" ? "aborted" : "failed";
  const body = JSON.stringify(result, null, 2);
  return {
    customType: "hana-background-result",
    content: `<hana-background-result task-id="${esc(taskId)}" status="${status}" type="download">\n${esc(body)}\n</hana-background-result>`,
    display: false,
    details: { schemaVersion: 1, taskId, deliveryId: `sync:${taskId}:${Date.now()}` },
  };
}
```

> 注释：保持 537747bf 旧版。  
> 依据：本次最小化不改 HBR 字符串模板；新增字段会因 `JSON.stringify(result, null, 2)` 自动进入内层 JSON，因此不需要改 `buildEntry` 即可让 agent 在 HBR 内层看到新字段。

---

## §5 预期效果

- 异步 `deferred:resolve` 路径里，宿主 `kst/vst/Est` 收到 result 时，result 已含 `source/plugin/status/timestamp/elapsed/action` 等新字段。
- 异步 HBR 内层 JSON 自动带新字段（因为 `JSON.stringify` 会序列化整个 result 对象）。
- agent 在新回合 input 里看到清晰通知：
  - 有 `source=system`、`plugin=download-progress`，能识别“这是系统后台通知”而非工具返回值。
  - 有 `status=done/cancelled/error/stall`，不再被外层 `status=success` 与内层 `state=running` 的旧组合误导。
  - 有 `timestamp`、`elapsed` 可判断通知新旧与耗时。
  - 有 `action=none/decide`，明确是否需要 agent 回应。
- 因此 agent 不再困惑“后台 done 通知也到了”。

---

## §6 最小验证步骤（agent 操作）

1. agent 用 `download-file` 下载 `http://127.0.0.1:8899/dl-local-probe.bin` 到 `D:\HanakoWorks\_temp\probe-min.bin`。
2. agent 保持会话不收束。
3. agent 调 1 次 `download-wait`（保持回合，创造同步条件）。
4. agent 收束。
5. 异步 `triggerTurn` 唤醒 agent 开新一轮，agent 在 input 的 `background-result` JSON 里看到：
   - `source=system`
   - `plugin=download-progress`
   - `status=done`
   - `timestamp`
   - `elapsed`
   - `action=none`
6. 验证判据：agent 看到后台通知后明确说出“这是来自 download-progress 的下载完成通知，含 source=system, status=done, timestamp=..., elapsed=..., action=none”（不再困惑“后台 done 通知也到了”）。

---

## §7 同步指引

dev 改完后，用 PowerShell 同步到宿主插件目录：

```powershell
Copy-Item "D:\HanakoWorks\download-progress\lib\delivery.js" "C:\Users\John Galt\.hanako\plugins\download-progress\lib\delivery.js" -Force
```

然后重启宿主，使改动生效。

---

*文档结束*
