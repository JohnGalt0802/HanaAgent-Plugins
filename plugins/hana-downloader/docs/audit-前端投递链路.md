# download-progress 前端 UI 「同步投递」可视化链路审计

> 范围：用户在前端聊天流看到的「大姐收到了来自 download 工具的结果 / 下载完成：xxx.bin」这种**同步投递提示**，从前端到宿主到底走哪条链路产生。
> 关键结论一句话：**这套「同步投递 UI 显示」完全由宿主内置的 `hana-background-result` + `display:false` 渲染管线驱动，下载插件自身的前端（card.js / manager.js）从不主动 emit / track / 上送任何 custom message**；它跟 agent jsonl 感知是**耦合于同一条 custom_message entry 的两条独立渲染分支**，但显示本身**不依赖 agent 是否在同轮回复**。
> 报告读完即可解释为什么前端 UI 一直能看到这条提示。

---

## 1. 前端卡片渲染全貌（插件自身的能力）

### 1.1 卡片声明（manifest.json）

`D:\HanakoWorks\download-progress\manifest.json` L31-53 声明两张 webview 卡片：

```json
"contributes": {
  "cards": [
    { "id": "download", "type": "webview", "route": "/card/download", "cardForm": "flush", ... },
    { "id": "manager",  "type": "webview", "route": "/manager",      "cardForm": "flush", ... }
  ],
  "configuration": { ... }
}
```

关键**没有**的贡献类型：

- **没有 `contributes.messageRenderers`**（搜过 `manifest.json`，零匹配）——所以插件**不参与**宿主 `resolveAppMessageRenderer(e)` 这条「customType → cardId」的映射（`bundle/index.js` L48007 `xRe` / L48056）。
- 没有 `capabilities` 里的 `emit` / `track`，没有 `card.emit` / `card.track` 调用面（`card-emit-guide.md` 第 42 行明确：「`pi.emit` 不存在」、「`card.emit` 只对卡片 slot 生效」，本插件**两面都没用**）。

### 1.2 卡片前端 card.js 的实际行为

`D:\HanakoWorks\download-progress\app\card.js` 是一个 iframe webview 卡片，纯**轮询 + 渲染**模型：

- **数据源**：每 600 ms 调一次 `apiFetch("/download/status?taskId=...")` 拿任务快照（L175 `timer = setInterval(poll, 600)`；L148-167 `poll()` 函数）。
- **渲染**：L248-405 `render(t)` 把状态机 `t.state ∈ {pending, running, done, failed, canceled, interrupted}` 渲染成 DOM。`stateBadge()` L419 把状态映射成中文「下载中/准备中/完成/失败/已取消/已中断/停滞」。
- **终态**：FINAL_STATES = { done, failed, canceled, interrupted }（L168），命中后 `stop()` 停止轮询。
- **与宿主通信**：仅 `hana.plugin.ui` 协议（mini host SDK，L96-115）：
  - `ui.resize` 上报内容高度给宿主（L153-188）—— 让 iframe 贴合卡片高度
  - `clipboard.writeText` 走 hostRequest（L250-263）—— 复制路径按钮
  - **没有任何 `card.emit` / `card.track` / `window.card.*` 调用**（grep 验证）
- **跨卡片同步**：`BroadcastChannel("hana-dl-cards")`（L268-281）—— 只同步「全部展开/收起」状态，跟投递无关

### 1.3 卡片前端 manager.js 的实际行为

`D:\HanakoWorks\download-progress\app\manager.js` 同款模式：

- **数据源**：每 3000 ms 调 `apiFetch("/download/list")` 拿跨会话任务列表（L33 `POLL_MS = 3000`，L420-444 `poll()`）
- **渲染**：L165-273 `render()` 列出任务行；L184-194 行背景按百分比填充
- **操作**：打开文件/文件夹（`/download/reveal`）、取消（`/download/cancel`）、清空（`/download/clear`）
- **与宿主通信**：同样只用 `hana.plugin.ui` 协议的 `ui.resize`（L115-122）和 `clipboard.writeText`，**没有**任何 emit/track 调用

### 1.4 前端的"通信集"完全封闭

| 出处 | 协议 | 内容 |
|---|---|---|
| card.js | `fetch('/download/status')`、`fetch('/download/cancel')`、`fetch('/download/reveal')` | 纯查询 / 操作 |
| card.js | `PARENT.postMessage({type:"ui.resize"})` | iframe 高度上报 |
| card.js | `PARENT.postMessage({type:"clipboard.writeText"})` | 复制路径 |
| card.js | `BroadcastChannel("hana-dl-cards")` | 同 surface 内折叠同步 |
| manager.js | 同上 + `/download/list`、`/download/clear`、`/download/cancel-all` | 同上 |

**没有任何一处**前端往宿主 push 自定义的「下载完成」「收到了来自 download 工具的结果」消息。

---

## 2. 用户看到的「同步投递提示」是哪条链路产生的

用户描述的两个文案：

- 「大姐收到了来自 download 工具的结果」
- 「下载完成：xxx.bin」

### 2.1 「大姐收到了来自 {source} 工具的结果」是宿主内置 i18n 文案

`C:\Users\John Galt\.hanako\artifacts\server\0.814.0-win32-x64\desktop\src\locales\zh.json` L4161-4170：

```json
"deferred": {
  "interlude": {
    "tool": {
      "success": "{receiver} 收到了来自 {source} 工具的结果",
      "failed":   "{receiver} 收到了来自 {source} 工具的结果",
      "aborted":  "{receiver} 收到了来自 {source} 工具的结果"
    },
    ...
  }
}
```

`{receiver}` 默认 `"Hana"`（`bundle/index.js` L49164 `VRe` 函数签名 `{ receiverName: t = "Hana" }`）。
`{source}` 取 `meta.toolName || meta.name || backgroundTask fallback`（`bundle/index.js` L49154 `r = FM(e.toolName || e.name || bH(t))`）。

### 2.2 这条文案是宿主「间奏 / interlude」渲染块

定义位置 `bundle/index.js` L49164-49187 `function VRe(e, ...)`：

```js
return {
  type: "interlude",
  variant: "deferred_result",         // ← 关键：间奏 / 居中事件卡
  taskId, status, sourceKind, sourceLabel,
  text: XSt({ receiverName, source, status }),  // ← "Hana 收到了来自 download 工具的结果"
  detailMarkdown: f
};
```

→ 这是宿主在聊天流里插入的**居中事件卡 / 间奏块**，不是工具返回值的内联块，不是插件卡片，不是 messageRenderer 输出的 plugin_card iframe。

### 2.3 这条 interlude 块是怎么构造出来的

入口条件（`bundle/index.js` L50182-50206 `function st(K, X)`）：

```js
function st(K, X) {
  if (X?.role !== "custom" || X.display !== !1 || X.customType !== ky) return null;
  //                                                    ↑ ky = "hana-background-result"
  const ee = pEe(X, { deliveryMode: "consumed" })?.presentation;
  if (!ee || Ie(ee)) return null;  // Ie 排除 image/video 生成
  ...
  const je = de(K, Te);  // de (L50161) 内部调用 VRe(...)
  return je ? { kind: Te.kind, ..., block: je } : null;
}
```

三连击触发条件：
1. `role === "custom"`（jsonl 自定义条目）
2. `display === false`（**关键**：宿主默认不自渲染成普通气泡）
3. `customType === "hana-background-result"`（bundle L18134 `const ky = "hana-background-result"`）

### 2.4 谁把 custom_message 写到 jsonl

下载插件的 `dl-nextturn.js`（`extensions/dl-nextturn.js` L122-148 `steerViaBus`）主通道：

```js
const res = await bus.request(
  "session:send-custom",
  {
    sessionPath: t.sessionPath,
    customType: "hana-background-result",
    content,                          // = <hana-background-result ...>下载完成：xxx.bin</hana-background-result>
    display: false,                   // ← 关键
    triggerTurn: true,                // ← unsettled 时让宿主主动发起新 turn
    details: { schemaVersion: 1, ...(details || {}) },
  },
  { caller: { pluginId: "download-progress" } }
);
```

`bus.request("session:send-custom", ...)` 走的是宿主 `sessionCoordinator` 路由（`docs/six-quadrant-test.md` L13：`bundle @7556119 session:send-custom` + `@953531 deliverCustomMessage`），最终由 `deliverCustomMessage` 写 jsonl entry：

- `entry.type === "custom_message"`
- `entry.message.role === "custom"`
- `entry.message.customType === "hana-background-result"`
- `entry.message.display === false` ← 关键
- `entry.message.content` = `<hana-background-result ...>下载完成：xxx.bin</hana-background-result>`
- `entry.message.details = { schemaVersion:1, taskId, canceledBy, userCanceled, ... }`

**这就是「前端可见同步投递」的真实源头**：宿主在 streaming 时扫到这个 entry 就把它送进前端 interlude 渲染管线。

### 2.5 streaming 时怎么把它挂到「待渲染队列」

`bundle/index.js` L50793：

```js
if (K.message?.role === "custom" && K.message.display === !1 && Qe(X, G, K.message),
    K.message?.role === "custom" && K.message.display !== !1) {
  // display !== false 的 custom_message 走另一路（普通气泡）
}
```

`Qe(K, X, me)` 定义在 L50207：

```js
function Qe(K, X, me) {
  const ee = st(K, me);  // ← 上一步的 interlude 构造器
  !ee || ge(X, ee) ||
    (X.pendingTurnInputConsumptions = [...X.pendingTurnInputConsumptions || [], ee]);
}
```

→ 把构造好的 `{ kind, deliveryId, presentation, input, block }` 推到 `pendingTurnInputConsumptions`。

### 2.6 turn 边界把它注入 stream → WS 推送 → 前端渲染

`bundle/index.js` L50267-50280 `$e(K, X, me = null)`：

```js
function $e(K, X, me = null) {
  const { items: ee, remaining: ae } = et(X, me);
  if (!ee.length) return [];
  X.pendingTurnInputConsumptions = ae;
  ...
  for (const G of ee) {
    ut(K, X, G);  // ← L50211：H(K, X, { type: "content_block", block: ee })
  }
}
```

`ut` → `H` 是宿主 stream event writer，把 `content_block` event 通过 WS 推给所有订阅前端。

`H` 的对外形态是 WS event `{ type: "content_block", block: { type:"interlude", variant:"deferred_result", taskId, status, text:"Hana 收到了来自 download 工具的结果", detailMarkdown, ... } }`。

前端 React UI 收到这个 event，按 `block.type === "interlude" && block.variant === "deferred_result"` 分支渲染间奏卡，**显示的就是 `text` 字段**（i18n 文案）。

### 2.7 调用链总结（一行一节点）

```
下载完成
  └─ extensions/dl-nextturn.js L122-148  steerViaBus()
       bus.request("session:send-custom", {
         customType: "hana-background-result",
         content: "<hana-background-result ...>下载完成：xxx.bin</hana-background-result>",
         display: false,
         triggerTurn: true,
         details: { schemaVersion:1, taskId, canceledBy, userCanceled }
       })
       └─ 宿主 bundle 路由 sessionCoordinator → deliverCustomMessage
            └─ 写 jsonl entry:  role:"custom" + customType:"hana-background-result" + display:false
                 └─ 宿主 agent loop streaming 扫 entry（bundle L50793）
                      if (role==="custom" && display===false) Qe(X, G, K.message)
                      └─ bundle L50207 Qe → L50182 st → L50161 de → L49164 VRe
                           VRe 返回 { type:"interlude", variant:"deferred_result",
                                     text: "Hana 收到了来自 download 工具的结果", detailMarkdown }
                           └─ push 到 session.pendingTurnInputConsumptions
                                └─ turn 结束（bundle L50848-50852）触发 $e/ut/H 注入 stream
                                     └─ WS event { type:"content_block", block } 推前端
                                          └─ React UI 渲染 interlude 块，显示文案
```

---

## 3. 下载完成时前端具体显示什么、通过什么 API

### 3.1 三类东西会在前端出现

| 显示物 | 谁产生 | 触发条件 | 内容 | 时机 |
|---|---|---|---|---|
| **① 进度卡（实时进度条/百分比/速度/剩余）** | 插件 card.js 轮询 `/download/status` | 任务存在 | 任务快照 | 任务创建 → 终态；600ms 轮询 |
| **② 管理卡（跨会话任务列表）** | 插件 manager.js 轮询 `/download/list` | 任务存在 | 列表 | 用户主动打开 manager 时；3000ms 轮询 |
| **③ 聊天流 interlude 块（「Hana 收到了来自 download 工具的结果」+ detail）** | **宿主内置管线** | jsonl 有 `role=custom + customType=hana-background-result + display=false` entry | 文案 + result JSON 预览 | turn 边界推送；与 agent 是否回复**无关** |

「前端可见的同步投递提示」= ③。**插件前端代码本身（card.js / manager.js）一字一句都没参与** ③ 的产生。

### 3.2 ③ 用的 API（**宿主侧，不经插件**）

- **写**：`bundle/index.js` L49164 `VRe()`、`L50161` `de()`、`L50182` `st()`、`L50207` `Qe()`、`L50267` `$e()`、`L50211` `ut()`、`L50089` `H()`
- **i18n key**：`desktop/src/locales/zh.json` `deferred.interlude.tool.{success,failed,aborted}`
- **消费**：`desktop/src/react/components/...`（前端 React）按 `block.type === "interlude" && block.variant === "deferred_result"` 渲染

### 3.3 ③ 的「detail」预览里是什么

`detailMarkdown` 来自 `bundle/index.js` L49141 `JSt()`：
```js
function JSt({ status, result, reason }) {
  const n = status === "success" ? oK(result) : US(reason) || V("deferred.noReason");
  return zSt(n || V("deferred.noPreviewText"));
}
```
即 success 时展示 result JSON（下载插件 result 形如 `{ type:"download", taskId, fileName, state, filePath, total, received }`），失败时展示 reason。所以用户点开间奏卡详情能看到 `{filePath:"...", total:..., received:...}` 等结构化信息。

### 3.4 ③ 与 ① ② 的关系

| 维度 | ① 进度卡 | ② 管理卡 | ③ interlude 块 |
|---|---|---|---|
| 来源 | 插件自己 | 插件自己 | **宿主内置** |
| 渲染对象 | 单任务 | 多任务列表 | 一次性事件 |
| 数据 | 轮询 `/download/status` | 轮询 `/download/list` | WS event content_block |
| 跟 agent 是否回应的耦合 | 0 | 0 | **0**（只在 turn 边界 flush，跟 LLM 是否调用无关） |
| 跟 dl-nextturn.js 的关系 | 0 | 0 | 通过 session:send-custom entry 写入 |
| 终止时机 | 终态后 stop() | 关闭 manager | 一次性 |

---

## 4. 前端可见线 vs agent 消息线的独立性分析

### 4.1 两条线在源码层面的耦合点

**下载插件当前的 dl-nextturn.js** 投递的是 `session:send-custom` + `customType: hana-background-result` + `display: false` + `triggerTurn: true`（unsettled 路径）。

这一条 entry 在宿主内部**同时**进入两条管线：

| 线 | 管线 | 触发位置 |
|---|---|---|
| **面① agent 消息线** | jsonl → 下一轮 LLM input | `bundle/index.js` `recordSessionCustomEntry` 写 jsonl 后，下次 runLoop 拼 input 时直接读出来（agent 必然看到） |
| **面② 前端视图线** | jsonl streaming 扫到 entry → `Qe()` → `pendingTurnInputConsumptions` → turn 边界 flush → WS content_block → React interlude 块 | `bundle/index.js` L50793 |

**两条线耦合于同一条 entry**，但**渲染函数互相独立**：
- 面① 是 agent loop / runLoop / LLM inference 路径
- 面② 是 stream event writer / WS / React render 路径
- 它们唯一的共享状态是 `session.pendingTurnInputConsumptions`

### 4.2 「前端显示同步投递」是否必然意味着 agent 也在同一轮收到消息？

**简短答案**：在 dl-nextturn 当前主通道（`session:send-custom` + `triggerTurn:true`）下，**是**——同一条 entry 既写 jsonl 又写 stream，两条线都会触发。但这跟"agent 是否在同一轮回复"无关。

**细致区分**：

1. **dl-nextturn session:send-custom + triggerTurn:true**（主通道，未收束）
   - `triggerTurn:true` 让宿主 `deliverCustomMessage` **主动发起一个新 turn** 消费消息（`bundle @953531` 非 streaming 分支 + `_emitTurnInputPresentation` + `sendCustomMessage({triggerTurn:true})`，见 `docs/six-quadrant-test.md` L13 / `extensions/dl-nextturn.js` 头部注释 L116-120）
   - 这条 entry 进 jsonl → agent 下一轮 input 包含 → agent 必读
   - 同一条 entry 在 streaming 扫到后 → interlude 块推到前端
   - **结论**：面① 同步 + 面② 同步，但**两者解耦**：即使 agent 不回复，面② 仍然显示

2. **dl-nextturn pi.sendMessage({deliverAs:"steer"}) 降级路径**
   - 走 `agent.steer()` 写入 `steeringQueue`，runLoop 内层每次生成前消费拼进 input
   - 同时宿主 streaming 扫这条 custom_message → 同样触发 interlude 块
   - **结论**：面① 同步 + 面② 同步，独立

3. **dl-nextturn deferred:resolve 路径（已收束）**
   - 宿主 `DeferredResultStore.resolve()`（`bundle/index.js` L167134 `FAr.resolve`）写 store + emit `{type:"deferred_result"}` event
   - 该 event 触发 `bundle/index.js` L50854 `K.type === "deferred_result"` 分支 → `te(X, K)` 构造 `MAt/DAt` block
   - **`MAt`（L49597）只处理 `result.sessionFiles`（返回 file blocks）`DAt`（L49627）只处理 `meta.mediaKind: image/video`（返回 media_generation blocks）**——**对 download 任务（type=download, 没有 sessionFiles, 不是 mediaKind），这俩都返回空 → 没有 interlude block**
   - 已收束状态下，宿主内部还有 `L189933 _handleBridgeSessionEvent` / `_handleDeferredResultMediaEvent`（L189936-189953）—— 这些是 **Bridge 渠道（外部群聊/IM）推送**，**不是桌面聊天流**
   - **结论**：已收束 + deferred 通道下，桌面端 chat UI 上**不会出现**「Hana 收到了来自 download 工具的结果」间奏块（只有 agent input 收到 `<hana-background-result>` 字符串）

### 4.3 独立性结论

- **面②（前端可见的「Hana 收到了……」块）的存在性**仅取决于 jsonl 里是否有 `role=custom + customType=hana-background-result + display=false` 的 entry 被 streaming 扫到并 flush。
- **面①（agent 感知）**取决于同一 entry 能否在 LLM 路径上被消费。
- 在 dl-nextturn 当前主通道下两者耦合触发（同一 entry 同步进两路）；但**渲染时机不同**——面② 由 WS 推流触发（turn 边界 flush），面① 由 LLM inference 触发。
- 即使 LLM 完全没动作（用户取消、agent 不在 run、API 错误），面② 仍然会显示。
- 反之，在已收束 / deferred:resolve 通道下面② 不出现，但面① 由宿主的 DeferredResultStore 异步投递（走 agent 唤醒路径）—— 此时**面② 与面① 也会解耦**。

→ 因此「前端可见同步投递 ≠ agent 必感知」和「agent 必感知 ≠ 前端必显示」**两种解耦情况都存在**。

---

## 5. 关键结论：前端这套同步显示靠什么机制持续运作

### 5.1 核心机制（不依赖 agent 感知）

```
下载完成
  → extensions/dl-nextturn.js: bus.request("session:send-custom", {customType:"hana-background-result", display:false, triggerTurn:true})
  → 宿主 deliverCustomMessage 写 jsonl entry（role=custom, customType, display=false）
  → 宿主 streaming 扫 entry（bundle L50793）→ Qe → st → de → VRe → interlude block
  → push 到 session.pendingTurnInputConsumptions
  → turn 边界 $e → ut → H 注入 stream (WS content_block event)
  → 前端 React UI 按 block.type="interlude" variant="deferred_result" 渲染间奏卡
  → 显示文案：i18n deferred.interlude.tool.success = "Hana 收到了来自 download 工具的结果"
```

**这套链路持续运作的充要条件**：

1. **插件投递协议不变**：`bus.request("session:send-custom")` + `customType:"hana-background-result"` + `display:false` 三件套
2. **宿主版本 ≥ 0.712.5**（`lib/deferred.js` 注释里实测版本）
3. **宿主内置管线生效**：bundle 内有 `ky = "hana-background-result"`、L50793 的 `Qe` 钩子、L50211 的 `ut` 注入、desktop locales 里有 `deferred.interlude.tool.success` 文案
4. **不依赖**：agent 是否在 run、agent 是否回复、agent 是否读完这条 message、card.js / manager.js 任何代码、manifest.json 的 `messageRenderers` 配置（插件没声明 `messageRenderers`，且不需要）

### 5.2 为什么「agent 没在 jsonl 里复述下载完成」但前端仍显示

原因即 §4.3：

- 同一 entry 同时进两条独立管线：
  - **面①**：jsonl → agent input → LLM → model output（受 LLM 决定影响，可能不复述）
  - **面②**：jsonl streaming → WS → React render（纯事件触发，与 LLM 解耦）
- 即使 LLM 因为 context 长、API 限流、模型选择、温度等原因没复述，面② 也照常显示。

### 5.3 插件前端（card.js / manager.js）的能力边界

插件前端**只**做两件事：
1. 轮询 `/download/status`、`/download/list` 拿数据 → DOM 渲染进度/列表（`card.js` L148-405、`manager.js` L165-273）
2. 上报 iframe 高度 + 复制路径到 clipboard（`hana.plugin.ui` 协议）

**它**：
- ❌ 不调用 `card.emit` / `card.track`（grep 全无）
- ❌ 不上送任何 custom_message / annotation / 系统提示
- ❌ 不参与「Hana 收到了来自 download 工具的结果」间奏块的产生
- ❌ 不需要 manifest 的 `messageRenderers` 贡献（插件没声明，宿主用内置 `hana-background-result` 处理）

**它**：
- ✅ 通过 `fetch` 轮询任务状态实时刷新
- ✅ 通过 `BroadcastChannel("hana-dl-cards")` 同步多张下载卡的折叠状态
- ✅ 通过 `hana.plugin.ui` 协议把 iframe 高度上报给宿主（让卡片贴合内容高度，不让前端"浏览器窗口感"溢出）

### 5.4 决定性证据点索引

| 证据 | 位置 |
|---|---|
| 插件前端从不 emit / track | `D:\HanakoWorks\download-progress\app\card.js`、`app\manager.js` 全文件 grep "emit\|track\|customType" 仅命中主题色 message 监听，无功能性调用 |
| 插件 manifest 没声明 `messageRenderers` | `D:\HanakoWorks\download-progress\manifest.json` grep "messageRenderers" 0 匹配 |
| `dl-nextturn.js` 主投递协议 | `extensions/dl-nextturn.js` L122-148 `steerViaBus` 内 `bus.request("session:send-custom", {customType:"hana-background-result", display:false, triggerTurn:true, ...})` |
| 投递 content 形态 | `extensions/dl-nextturn.js` L334 `content = <hana-background-result status="..." type="download" task-id="..." canceled-by="..." user-canceled="...">下载完成：${fileName}</hana-background-result>` |
| 宿主内置 `hana-background-result` 常量 | `bundle/index.js` L18134 `const ky = "hana-background-result"` |
| 宿主 streaming 钩子 | `bundle/index.js` L50793 `K.message?.role === "custom" && K.message.display === !1 && Qe(X, G, K.message)` |
| 宿主 interlude 构造 | `bundle/index.js` L49164-49187 `VRe` 函数返回 `{type:"interlude", variant:"deferred_result", text: XSt(...), detailMarkdown}` |
| 宿主 interlude 文案 i18n | `desktop/src/locales\zh.json` L4161-4170 `deferred.interlude.tool.success = "{receiver} 收到了来自 {source} 工具的结果"` |
| 注入 stream 路径 | `bundle/index.js` L50211 `ut` → L50089 `H` → WS content_block event |
| SDK / 协议层面对照 | `D:\HanakoWorks\_temp\sdk-814\hana-plugin-protocol-0.0.0\package\dist\index.d.ts` L373 `PLUGIN_V2_MANIFEST_CONTRIBUTES_KEYS = [..., "messageRenderers"]`；L430 `PLUGIN_V2_MESSAGE_RENDERER_CONTRIBUTION_KEYS = ["customType", "cardId"]` —— 这是宿主 v2 协议层定义的「customType → cardId」通道，本插件没用到 |

### 5.5 一句话总结

**前端聊天流上的「Hana 收到了来自 download 工具的结果」间奏块由宿主内置的 `hana-background-result` + `display:false` 渲染管线驱动：插件仅需用 `session:send-custom` 把对应 customType 的 entry 写进 jsonl，宿主在 streaming 时自动把它渲染到聊天流。这套机制与 agent 是否在同轮回复无关、且不需要插件前端代码参与。**
