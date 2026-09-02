# hana-downloader 后台通知 Prompt 模板调研与优化草案

> 日期：2026-09-02  
> 范围：仅调研 dev 源 `<workspace>\hana-downloader` + 宿主 bundle `0.814.0`，产出优化草案，不改代码。  
> 核心判据：以 agent 在下一轮提示词（`payload.messages` / jsonl `custom_message`）里实际看到的字符串为准，不依赖日志。

---

## §1 当前模板（字符串样例 + 文件位置:行号）

### 1.1 插件侧拼装点：`lib/delivery.js`

- **`buildResult(task)`**：`lib/delivery.js:89-104`  
  构造投递用的结构化 `result`，目前字段：`type`、`taskId`、`fileName`、`state`、`consumedByWait`；done 追加 `filePath/total/received`；失败/取消追加 `error/canceledBy/userCanceled/hint`。
- **`buildEntry(taskId, result)`**：`lib/delivery.js:106-115`  
  把 `result` 包成 XML-like HBR 字符串：

```js
customType: "hana-background-result",
content: `<hana-background-result task-id="${esc(taskId)}" status="${status}" type="download">\n${esc(body)}\n</hana-background-result>`,
```

其中 `status = done ? "success" : canceled ? "aborted" : "failed"`（`delivery.js:107`），`body = JSON.stringify(result, null, 2)`。

- **`handleStall` 的 result**：`lib/delivery.js:249-260`  
  额外有 `type:"download-stall"`、`url`、`stalledAt`、`hint`，但 `state` 仍是任务当前状态（通常 `running`），且没有来源/时间/耗时/行动标记。

### 1.2 宿主侧拼装点：`bundle/index.js`

宿主异步 `deferred:resolve` 到 `custom_message` 时也会生成 HBR，模板见：

- `kst()`：`bundle/index.js:18149-18154`（success）
- `vst()`：`bundle/index.js:18155-18160`（failed）
- `Est()`：`bundle/index.js:18161-18166`（aborted）
- `Pst()` / `D0e()`：`bundle/index.js:18167-18184`

宿主模板与插件模板几乎相同：

```html
<hana-background-result task-id="..." status="success" type="...">
{JSON 或 reason}
</hana-background-result>
```

宿主不会为 agent prompt 额外改写这段字符串；同步注入时插件把 `entry.content` 原样 push 进 `payload.messages`，异步投递时宿主把 `D0e()` 生成的 `content` 写入 jsonl `custom_message`，agent 下一轮看到的就是这段 XML-like 文本。

### 1.3 当前字符串样例（实测 jsonl 原样复制）

#### done（来自 `2026-09-01T18-42-22-...jsonl` line 23，taskId `65ec5d25-mtj0lfco`）

```text
<hana-background-result task-id="65ec5d25-mtj0lfco" status="success" type="download">
{
  &quot;type&quot;: &quot;download&quot;,
  &quot;taskId&quot;: &quot;65ec5d25-mtj0lfco&quot;,
  &quot;fileName&quot;: &quot;dl-sync-new-sess.bin&quot;,
  &quot;state&quot;: &quot;done&quot;,
  &quot;consumedByWait&quot;: false,
  &quot;filePath&quot;: &quot;\<workspace>\\_temp\\dl-sync-new-sess.bin&quot;,
  &quot;total&quot;: 1024,
  &quot;received&quot;: 1024
}
</hana-background-result>
```

#### stall（来自同 jsonl line 152，taskId `d74aefd0-mtjdteuo:stall:...`）

```text
<hana-background-result task-id="d74aefd0-mtjdteuo:stall:1788310362985" status="success" type="download-stall">
{
  &quot;type&quot;: &quot;download-stall&quot;,
  &quot;taskId&quot;: &quot;d74aefd0-mtjdteuo&quot;,
  &quot;fileName&quot;: &quot;dl-sync-probe-9.bin&quot;,
  &quot;url&quot;: &quot;https://httpbin.org/bytes/1024&quot;,
  &quot;state&quot;: &quot;running&quot;,
  &quot;received&quot;: 0,
  &quot;total&quot;: 0,
  &quot;stalledAt&quot;: 1788310362984,
  &quot;hint&quot;: &quot;下载连接已停滞（500ms 无新数据）。请决策：继续等待 / 换源重下 / 取消任务。&quot;
}
</hana-background-result>
```

#### error / cancelled（当前代码推断样例，未在本次 jsonl 截获）

当前 `buildResult` 对非 done 状态会输出 `error`、`canceledBy`、`userCanceled`、`hint`，因此当前模板大致为：

```text
<hana-background-result task-id="..." status="failed" type="download">
{
  &quot;type&quot;: &quot;download&quot;,
  &quot;taskId&quot;: &quot;...&quot;,
  &quot;fileName&quot;: &quot;...&quot;,
  &quot;state&quot;: &quot;failed&quot;,
  &quot;error&quot;: &quot;HTTP 404 Not Found&quot;,
  &quot;canceledBy&quot;: null,
  &quot;userCanceled&quot;: false
}
</hana-background-result>
```

### 1.4 其他拼装点核查

- `lib/deferred.js`：`resolveDeferred()` 只构造 `result` 对象（`lib/deferred.js:140-155`），不拼 HBR 字符串；字符串由宿主 `kst/vst/Est` 生成。
- `lib/dlcore.js`：没有 `handleFinal/handleStall` 字符串拼装；只提供 `_fireFinal/_fireStall` 与任务字段（`startedAt/finishedAt/elapsed/error/total/received/stalledAt`）。
- `extensions/dl-nextturn.js`：当前为空壳占位（9 行），不拼通知字符串。
- `extensions/dl-sync.js` / `index.js`：只负责把 `delivery.injectForSession()` 的 `entry.content` 注入 `payload.messages`，不再改写字符串。

---

## §2 agent 实际看到的（jsonl 引用）

文件：  
`~/.hanako\agents\hanako\sessions\2026-09-01T18-42-22-560Z_01a05e47-8ce0-78d3-aa63-031d1f13759c.jsonl`

### 2.1 本地快速下载任务 `9ab2a343-mtje3805`

- 第 161 行：`download-wait` 返回 `done / 100% / 256KB / 262144 字节`。
- 第 162 行 agent 思考原文：

> 第1次download-wait返回：done, 100%, 256KB/256KB（262144字节）。后台done通知也到了：state=done, total=262144, received=262144。

这说明 agent 在同一段思考里把「主动 `download-wait` 的工具返回值」和「系统注入的 HBR 通知」并列提及，且用“后台done通知也到了”来描述后者。由于 HBR 正文只有 `state/total/received`，没有任何“这是系统通知、来源是 hana-downloader、无需你再次确认”的标识，agent 无法一眼区分两者。

### 2.2 stall 任务 `d74aefd0-mtjdteuo`

- 第 139-148 行：agent 连续 5 次 `download-wait`，每次都返回 `done / 100% / 1.00KB`。
- 第 152 行：宿主异步投递的 stall HBR 到达，正文是 `state=running, received=0, total=0, stalledAt=..., hint=...`。
- 第 153 行 agent 对 stall HBR 的回应：

> probe-9 的 stall 虚警迟到了（received=0，第 12 条），但结果无影响……

agent 已经学会把这类 stall 当成“虚警/噪声尾巴”，但也正说明当前 stall 通知本身没有携带：
- 当前真实任务状态（其实 `download-wait` 已 done）；
- 该通知是否需要 agent 行动；
- 通知生成时间与 stall 发生时间；
- 与已完成 done 通知的优先级关系。

### 2.3 小结：agent 看到的原始形态

agent 在提示词里看到的 HBR 就是 §1.3 那段 XML-like 字符串。宿主没有为 agent 增加“系统通知”前缀、行动提示或人类可读摘要；agent 需要自己从 JSON 字段里猜“这是通知还是查询结果、要不要处理”。

---

## §3 困惑根因（list）

1. **没有来源标识**：HBR 没有 `source` / `plugin` / `from` 字段，agent 无法区分“这是系统后台通知”还是“工具返回/主动查询结果”。
2. **“后台通知”一词只在 agent 脑中，模板里没有**：模板本身没有 `[系统通知]` / `[来自下载进度模块]` 这类显眼前缀，所以 agent 只能自己起名“后台done通知”。
3. **`status` 与 `state` 双轨且语义不一致**：
   - 外层 `status="success/failed/aborted"` 是投递状态；
   - 内层 `state="done/running/failed/canceled"` 是任务状态；
   - stall 场景外层 `status="success"`、内层 `state="running"`，非常反直觉。
4. **stall 通知缺少“当前是否仍有效/是否需要行动”**：`hint` 虽写了“请决策”，但没有说明“以最新 `download-wait` 或 done 通知为准”，导致 agent 反复被 received=0 的滞后 stall 打断。
5. **没有 task ID 之外的关联上下文**：stall HBR 的 `task-id` 是 `原始taskId:stall:时间戳`，而内层 `taskId` 是原始 ID；两个 ID 不一致，agent 需要自行辨别。
6. **没有时间戳**：`stalledAt` 是毫秒数，done 通知连时间都没有；agent 无法判断通知新旧/是否滞后。
7. **没有耗时（elapsed）**：done/error 均无 `elapsed`，agent 无法快速评估下载耗时是否异常。
8. **错误信息不结构化**：`error` 只是字符串，没有 `errorCode` / `errorMessage` 分离；HTTP 状态码和网络错误混在一起。
9. **没有行动提示**：done 通知没有“无需回应”，stall/error 没有明确“需要 Agent 回应：继续等待/换源/取消”的决策项；agent 只能靠 hint 自由发挥。
10. **格式不显眼**：整段是 JSON 包在 XML-like 标签里，agent 在长上下文中容易把它当成普通工具输出，而不是系统级后台事件。

---

## §4 优化后模板（done/error/stall/cancelled 四种样例）

### 4.1 设计原则

- 保留 `<hana-background-result>` 根标签，兼容宿主 HBR 解析与 jsonl `custom_message` 通道。
- 根标签属性放机器可读的关键字段：`task-id`、`source`、`plugin`、`type`、`status`、`timestamp`、`action`。
- 正文第一行放**人类可读摘要**，用 `[系统通知]` / `[来自下载进度模块]` 开头，杜绝“后台通知”这种模糊说法。
- 正文后续用 `key: value` 或 JSON 呈现细节；继续保留 JSON 块以便宿主/前端展示结构化结果。
- 每个模板都带明确的 `action` / `[无需回应]` / `[需要 Agent 回应：xxx]`。

### 4.2 done（成功）

```text
<hana-background-result
  task-id="9ab2a343-mtje3805"
  source="system"
  plugin="hana-downloader"
  type="download"
  status="done"
  timestamp="2026-09-02T01:00:20.180Z"
  action="none">
[系统通知][来自下载进度模块] 下载任务已完成，无需回应。
task-id: 9ab2a343-mtje3805
type: download
status: done
file-path: <workspace>\_temp\dl-local-probe-dl.bin
bytes: 262144 / 262144
elapsed: 0.35s
[无需回应]
{
  "taskId": "9ab2a343-mtje3805",
  "fileName": "dl-local-probe-dl.bin",
  "filePath": "\<workspace>\\_temp\\dl-local-probe-dl.bin",
  "total": 262144,
  "received": 262144,
  "elapsedMs": 350,
  "elapsed": "0.35s"
}
</hana-background-result>
```

### 4.3 error（失败）

```text
<hana-background-result
  task-id="ab12cd34-mtje9999"
  source="system"
  plugin="hana-downloader"
  type="download"
  status="error"
  timestamp="2026-09-02T02:10:00.000Z"
  action="decide">
[系统通知][来自下载进度模块] 下载任务失败，需要 Agent 决策。
task-id: ab12cd34-mtje9999
type: download
status: error
file-path: <workspace>\_temp\failed-download.bin (未完成，保留 .part)
bytes: 524288 / 1048576
elapsed: 12.4s
error-code: HTTP_404
error-message: HTTP 404 Not Found
[需要 Agent 回应：可换源重试 / 放弃该任务 / 检查 URL]
{
  "taskId": "ab12cd34-mtje9999",
  "fileName": "failed-download.bin",
  "filePath": "\<workspace>\\_temp\\failed-download.bin",
  "total": 1048576,
  "received": 524288,
  "elapsedMs": 12400,
  "elapsed": "12.4s",
  "errorCode": "HTTP_404",
  "errorMessage": "HTTP 404 Not Found"
}
</hana-background-result>
```

### 4.4 stall（停滞）

```text
<hana-background-result
  task-id="d74aefd0-mtjdteuo:stall:1788310362985"
  source="system"
  plugin="hana-downloader"
  type="download"
  status="stall"
  timestamp="2026-09-02T00:52:42.985Z"
  action="decide">
[系统通知][来自下载进度模块] 下载连接停滞，需要 Agent 决策；请以最新 download-wait / done 通知为准。
task-id: d74aefd0-mtjdteuo
type: download
status: stall
bytes: 0 / 1024
elapsed: 1.2s
stalled-at: 2026-09-02T00:52:42.984Z
[需要 Agent 回应：继续等待 / 换源重下 / 取消任务]
{
  "taskId": "d74aefd0-mtjdteuo",
  "fileName": "dl-sync-probe-9.bin",
  "url": "https://httpbin.org/bytes/1024",
  "state": "running",
  "received": 0,
  "total": 1024,
  "elapsedMs": 1200,
  "elapsed": "1.2s",
  "stalledAt": 1788310362984,
  "note": "若该任务随后已完成，请以 done 通知或 download-wait 返回为准，本通知可忽略。"
}
</hana-background-result>
```

### 4.5 cancelled（用户取消）

```text
<hana-background-result
  task-id="aa11bb22-mtje7777"
  source="system"
  plugin="hana-downloader"
  type="download"
  status="cancelled"
  timestamp="2026-09-02T03:05:00.000Z"
  action="none">
[系统通知][来自下载进度模块] 下载任务已被用户取消，非故障，无需自动重试或换源。
task-id: aa11bb22-mtje7777
type: download
status: cancelled
file-path: <workspace>\_temp\user-cancelled.bin (.part 可能保留)
bytes: 2048 / 1048576
elapsed: 3.1s
canceled-by: user
[无需回应]
{
  "taskId": "aa11bb22-mtje7777",
  "fileName": "user-cancelled.bin",
  "filePath": "\<workspace>\\_temp\\user-cancelled.bin",
  "state": "canceled",
  "canceledBy": "user",
  "userCanceled": true,
  "total": 1048576,
  "received": 2048,
  "elapsedMs": 3100,
  "elapsed": "3.1s",
  "hint": "用户手动取消（非故障，无需自动重试或换源）"
}
</hana-background-result>
```

---

## §5 应用建议（哪些函数改、改哪些字段、是否要兼容旧字段）

### 5.1 建议修改点

| 文件 / 函数 | 改什么 |
|---|---|
| `lib/delivery.js` `buildResult()` | 在 result 中补充 `source:"system"`、`plugin:"hana-downloader"`、`status`（与 `state` 解耦：done/error/stall/cancelled）、`timestamp`、`elapsedMs`、`elapsed`、`errorCode`、`errorMessage`、`action`。 |
| `lib/delivery.js` `buildEntry()` | 把 `status` 改为直接使用 `result.status`（done→done、failed→error、stall→stall、canceled→cancelled），并在 HBR 根标签上输出 `source/plugin/status/timestamp/action`。正文首行输出人类可读摘要，再保留 JSON 块。 |
| `lib/delivery.js` `handleStall()` | stall result 增加 `status:"stall"`、`timestamp`、`elapsed`，并把 `hint` 改成“请以最新 download-wait / done 通知为准”的明确说明。 |
| `lib/delivery.js` `handleFinal()` | 确保 canceledBy=user 的 result 使用 `status:"cancelled"`，并带 `action:"none"`；agent 取消仍静默。 |
| `lib/dlcore.js` `_run()` / `_runCommand()` | 可选：新增 `errorCode` 字段（如 `HTTP_404`、`NETWORK_ECONNRESET`、`SHA256_MISMATCH`），把 `error` 拆成 `errorMessage`；至少可在 delivery 层从现有 `error` 字符串解析出 HTTP code 作为 `errorCode`。 |
| `lib/deferred.js` `resolveDeferred()` | 同步补齐 result 字段，避免异步路径（宿主 kst 生成 HBR）缺少新字段。 |
| `extensions/dl-sync.js` / `index.js` | 不需要改字符串；只要 delivery 的 `entry.content` 变新，注入就是新模板。 |

### 5.2 字段兼容策略

- **保留旧字段**：`type`、`taskId`、`fileName`、`state`、`total`、`received`、`error`、`canceledBy`、`userCanceled`、`hint` 全部保留，避免破坏宿主 `xD` 解析、前端 detail 预览和已有测试。
- **新增字段**：`source`、`plugin`、`status`、`timestamp`、`elapsedMs`、`elapsed`、`errorCode`、`errorMessage`、`action`。
- **新旧映射**：
  - 外层 `status="success"` → 建议改为 `status="done"`（但若担心宿主 interlude 的 success/failed/aborted 判定，可先保留外层 `status` 为宿主语义，同时在内层 JSON 增加 `status:"done"`；更彻底的做法是同步修改宿主 `kst/vst/Est` 或让插件统一生成）。
  - 内层 `state="running"` + 外层 `status="success"`（stall） → 统一为 `status="stall"`，避免歧义。
- **向后兼容**：如果宿主或前端仍依赖 `status="success"` 作为成功判定，建议先做“双字段”：根标签保留 `status="success"` 的同时新增 `event-status="done"` 或 `state="done"`；正文 JSON 使用 `status:"done"`。在确认宿主可接受新语义后再逐步切换。

### 5.3 落地顺序建议

1. 先在 `buildResult()` / `buildEntry()` 增加新字段和可读摘要，旧字段不删。
2. 用本地快速下载（done）、人为构造失败（error）、停滞（stall）、用户取消（cancelled）四类场景实测，确认 agent 在下一轮 `payload.messages` 中看到新模板后能直接说出“这是系统通知、不需要/需要行动”。
3. 再决定是否同步调整宿主 `bundle/index.js` 的 `kst/vst/Est` 模板，使异步 `deferred:resolve` 路径与同步注入路径使用同一套新模板。
4. 不建议直接删除“后台通知”相关旧字段；用新增显式 `[系统通知]` 前缀逐步替代，避免旧测试/旧前端兼容断裂。

---

*文档结束*
