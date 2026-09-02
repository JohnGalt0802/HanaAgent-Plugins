# download-progress 插件 · 结构解剖报告

> 落盘时间：2026-09-01（会话快照内的当前装机版）
> 审视对象：`D:\HanakoWorks\download-progress\`（dev 槽 sourcePath，运行拷贝在 `C:\Users\John Galt\.hanako\plugins-dev\download-progress`）
> 审视方式：只读通读所有源码 + docs/* + 顶层文档，逐处标注关键机制的文件/函数/注释位置。

---

## 0. 目录树速览（仅当前装机真实存在的文件）

```
download-progress/
├── .gitignore
├── README.md
├── PROJECT_REQUIREMENTS.md
├── 踩坑记录.md
├── manifest.json
├── package.json
├── index.js                       ← 插件生命周期
├── lib/
│   ├── dlcore.js                  ← 任务管理器（49.9KB, 最大模块）
│   ├── deferred.js                ← 占位 helper（v0.8）
│   ├── registry.js                ← 宿主 TaskRegistry 封装
│   └── progress-parsers.js        ← git / pnpm 输出解析
├── extensions/
│   ├── dl-nextturn.js             ← 投递层【唯一权威】(dual-channel)
│   └── enforce-download.js        ← 下载铁律注入（当前宿主未桥接，休眠）
├── app/
│   ├── card.js / card.css
│   └── manager.js / manager.css
├── routes/
│   └── download.js                ← 全部路由（卡片/管理器/状态/取消/...）
├── tools/
│   ├── download-file.js           ← URL 下载
│   ├── download-command.js        ← git-clone / pnpm-install
│   ├── download-wait.js           ← 回查工具（纯快照，不守望）
│   ├── download-cancel.js         ← 取消工具
│   └── dl-recon.js                ← 早期外部侦察脚本（已存档/不再用）
├── patch/
│   ├── patch-theme-0.680.21.js    ← 宿主 theme.js 广播 patch（一键重打）
│   └── README.md
└── docs/
    ├── card-emit-guide.md
    ├── delivery-判定标准.md
    ├── six-quadrant-test.md
    └── sync-mechanism.md
```

**用户列出的 `tools/dl-native-probe.js` 在当前装机版本中不存在**——`grep -r dl-native-probe download-progress/` 零命中。最可能历史身份：`dl-recon.js`（侦察脚本）即其职能替身；最终方案已被 `extensions/dl-nextturn.js` 内部的 800ms 轮询 + `onFinal` 取代，独立探测脚本无存在必要。

---

## 1. 顶层职责与生命周期（onload）

入口 `index.js` 唯一定义了 `DownloadProgressPlugin` 类，仅实现 `async onload()`。整个生命周期就这一段。

**onload 步骤（按代码顺序）**：

1. **构建 TaskManager 单例并恢复**
   - `getTaskManager(dataDir)` → 经 `globalThis.__dlTaskMgr`（避开插件加载器的 lib 模块缓存）+ `MGR_VER=20` 版本哨兵
   - `manager.restore()` 读 `tasks.json`：running/pending → `interrupted`（已删半成品：URL 任务保留 `.part`、git-clone 删半成品目录、pnpm-install 保留 node_modules）；其余终态只保留 24h 内（`lib/dlcore.js:758-826` 注释 "重启恢复" 段）
   - `this.ctx._dl = manager` + `globalThis.__dlBus = bus`（工具上下文兜底回退取用，见 `lib/deferred.js:getBus`）

2. **注册宿主 abort handler（必须在任何 task:register 之前一次完成）**
   - `await registerHandler(bus, () => getTaskManager(dataDir))` —— `lib/registry.js:60-78`
   - 注册 `type="download"` 的 abort 回调：宿主 `stop_task` 调用时调 `manager.cancel(taskId, "user")`，统一取消链路（`source:"user"`）

3. **打印加载日志**
   - `log.info(`download-progress v0.9.0 loaded (downloads → ${manager.downloadDir})`)` —— 见 §7 版本号讨论

4. **停滞占位托管（onStall IIFE）**
   - `manager.onStall((task) => { ... })` —— `index.js:51-71`
   - 双保险之一：每个停滞任务用 `taskId + ":stall:" + Date.now()` 作唯一 key，避免复用已终态 key
   - 注册 + 立即 resolve，但如果 `task._stallDelivered` 已被扩展置位，则 `deferred:suppress` 兜底熄 own stallKey（dl-nextturn 同步抢旗机制）
   - 注：`index.js` 的 `onStall` 与 `dl-nextturn` 的 `onStall` 都挂在 `manager._stallCbs` 数组里，多监听器 fan-out（`dlcore.js:onStall` 注释 "v0.8 支持多监听器"）

5. **6s 后的兜底扫描（疑似遗留终态 → resolve / 补注册）**
   - `setTimeout(..., 6000)` —— `index.js:90-138`
   - 扫描内存中所有 `terminalStates.has(t.state)` 的任务
   - 短路项：`_delivered/delivered` 已有任一为真 / `consumedByWait/waitActive` 标识 Agent 已收
   - **先对账宿主 `deferred:query`**：宿主 store 真已投递则 `markDelivered` 同步旗标后跳过（v0.8.8 修 test8/test9 跨 realm 双投）
   - 未投递：`deferredRegistered === true` → 直接 `resolveDeferred`；未注册但有 `sessionPath` → `registerDeferred(..., null)` 补占位（内部对终态任务立即 resolve）
   - 重要注释：`v0.8.7 兑底串行化（修 test8/test9 跨 realm 双投）—— 扩展 dl-nextturn 先跑（onFinal→+2s），兑底延到 +6s`，避免双投竞争

**关键设计取舍**（注释明确写出）：
- 主逻辑【不再】对普通任务调 `resolveDeferred`（v0.8 起）：会让"扩展未加载 / 扩展链路断裂"导致漏通知，但反过来要严格避免与扩展双投。**当前策略：扩展是唯一权威；兑底仅作为扩展加载失败 / 序列化窗口外的兜底。**
- 宿主整体重启会清空宿主侧占位，无法补回（宿主无持久占位）；如实降级为"热重载缝隙覆盖"。

**`onload` 没有反操作对称卸载**：插件无 `unload` 实现（卸载时进程结束，不需要）。

---

## 2. lib/ 层

### 2.1 `lib/dlcore.js`（49.9KB，主任务管理器）

**职责（注释 L1-2）**：创建/准备下载任务、流式下载 + 进度统计、限速、取消、状态快照、持久化恢复。**不依赖任何第三方库**，纯 Node 18+ 全局 fetch + 手写 HTTP 客户端。

**关键常量（`lib/dlcore.js:11-18`）**：
- `MAX_TASKS = 64`：内存中允许同时存在的最大任务数
- `SPEED_SAMPLE_MS = 700`、`SPEED_SAMPLES_MAX = 5`：约 3.5s 滑窗测速
- `CHUNK_SLEEP_MIN_MS = 1`：限速 sleep 钳位
- `MGR_VER = 20`：`globalThis` 单例版本哨兵——`index.js:29`（"+1：v20=加 clearByStates/cancelAll"）

**导出函数**：
```js
getTaskManager(dataDir) → TaskManager      // singleton-by-VER
_resetTaskManager()                         // 供测试/路由侧重建（routes/_freshManager）
```

**类 `TaskManager` 公开方法**：
| 方法 | 行 | 用途 |
|---|---|---|
| `restore()` | ~560 | 读 tasks.json 重生 interrupted（见 §1） |
| `create({...})` | `prepare()` 之前 | 创建并立即启动（传 `startDelayMs`=0），UI 入口用 |
| `prepare({..., startDelayMs})` | ~250 | pending 占位 → setTimeout/delay 后 startPending；保证卡片从 0% 开始 |
| `startPending(taskId)` | ~220 | pending → running，启动 `_run` |
| `cancel(taskId, source)` | ~720 | `pending` → 直接 canceled；`running+command` → taskkill /T 进程树（Windows）或 SIGTERM；`running+url` → `controller.abort()`；`source` ∈ `user/agent/system` |
| `snapshot(taskId)` | ~770 | 状态快照（卡片轮询用，固定字段 + `percent`） |
| `markConsumedByWait(taskId)` | ~810 | v0.5.7 关键：Agent 已通过 wait 拿到结果 → 抑制后续 deferred 投递 |
| `markWaitActive/Inactive(taskId)` | ~820+ | wait 计数（>0 抑制投递） |
| `markWaitBudgetExhausted(taskId)` | ~835 | 守望预算用尽，禁止二次守望 |
| `markDelivered(taskId)` | ~190 | 持久化 `delivered=true`（dl-nextturn 同步成功后调用） |
| `getTask(taskId)` | ~175 | 内存引用（只读使用，deferred 复查用） |
| `list()` | ~870 | 在途优先 + 终态按 finishedAt 倒序 → 所有任务快照 |
| `clearByStates(states)` | ~890 | v0.8.9 管理器清空（不删磁盘文件） |
| `cancelAll(source)` | ~915 | v0.8.9 管理器"全部取消" |
| `recordSpeed(host, speed)` / `getHostSpeed(host)` | ~60+ | 域名历史速度缓存（`speed-cache.json`，供 wait auto 模式预估算阈值，虽 README 写有 waitWatchMode，实际当前 download-wait 是纯快照模式不再 auto 限值） |
| `onFinal(cb)` | ~85 | 单订阅（注释："v0.6.6 起主逻辑不再订阅 onFinal，终态投递由扩展 dl-nextturn 负责；保留此 API 仅供扩展或第三方接入使用"） |
| `onceFinal(taskId)` | ~95 | 一次性 Promise-wait + `cancel()`（扩展 dl-nextturn 用） |
| `onStall(cb)` | ~135 | **多监听器**（index.js + dl-nextturn 都挂） |
| `_fireFinal(task)` | ~125 | 内部：唤醒 onceFinal waiter 后调 `_finalCb` |
| `_fireStall(task)` | ~145 | 内部：遍历调用所有 stallCb |
| `_run(task)` | ~285 | URL 流式下载主循环（含 416 续传偏移不符/200 自动从头、SHA-256 校验、限速）；catch 块标 `complete = !aborted && wroteAnyChunk && total != null && received >= total && received > 0`（半成品完整性红线） |
| `_runCommand(task)` | ~570 | 命令型：spawn → stdout/stderr 喂 `progress-parsers.js` → `child.close` 判 done/failed/canceled；git-clone 取消时删半成品目录，pnpm 保留 |
| `_createTask({...})` | ~225 | 构造 task 对象（含 `consumedByWait/waitActive/waitBudgetExhausted/_samples/_lastProgressAt/stallTimeoutMs` 等元字段） |
| `_startStallMonitor(task)` / `_stopStallMonitor(task)` | ~280 | 每 5s 检查 "task 实际有进度" 是否超出 stallTimeoutMs；触发一次 `_fireStall` 后需进度恢复才能再触发 |
| `_persist()` | ~1015 | 写到 `tasks.json`（version=3 schema，**终态任务按 finishedAt 倒序只保留 100 条**） |

**底层 HTTP（手写，无第三方依赖）**：
- `resolveProxy(dataDir)` —— `HTTPS_PROXY/HTTP_PROXY/env` > `config.json:proxy` > Windows 注册表 `HKCU\...\Internet Settings\ProxyServer`
- `createTunnelAgent(proxyUrl)` —— 手写 HTTP CONNECT 隧道 Agent（基于 `https.Agent.createConnection`）
- `readSmallBody(res)` —— Content-Length < 4KB 时读完整 body，专门检测 npmmirror 这类"Redirecting to <url>"文本重定向
- 请求循环：5 次 max redirect（标准 3xx + 文本重定向）；代理策略失败自动降级直连；416 → 删 `.part` 从头；4xx/5xx 走代理路径重试直连一次

**关键完整性规则（`lib/dlcore.js:_run` catch 块）**：
- `received < total` **不拉低**（半途断连一律失败，不当成功，避免把残缺文件误当完整保留）
- 续传必须 received ≥ total 且 `wroteAnyChunk=true`（请求阶段失败不会误判 complete）
- SHA-256 校验不一致 → state=failed 并保留 .part

**模块依赖**：`lib/progress-parsers.js`（动态 import，命令型任务专用）

### 2.2 `lib/deferred.js`

**职责（注释 L1-2）**：deferred 占位 helper（v0.8）。**实现宿主协议的封装 + 投递去重决策**。

**宿主协议清单（L5-13）**：
```
deferred:register   注册占位
deferred:resolve    解析占位（→ 投递 hana-background-result；占位不存在/已终态则幂等无操作）
deferred:fail       同上但投失败结果（未使用）
deferred:retry      覆盖式重置回 pending + 清 result/reason/delivered/suppression（再武装）
deferred:abort      pending → aborted（会投失败消息；本插件不用："任务中止"误报）
deferred:suppress   ← 宿主无此路由（status=aborted+deliverySuppressed=true 标记）——文档/PROJECT_REQUIREMENTS 都已标注为"补丁回滚死路"
deferred:query      查询占位真实状态（v0.8.5 起 dl-nextturn 用于确认送达）
```

**导出函数**：
```js
getBus(bus) → bus | globalThis.__dlBus | null      // 工具上下文无 bus 兜底
sessionSettled(task) → boolean                     // 备用：尾部扫描（dl-nextturn 有同口径 tailSettled）
registerDeferred(bus, task, extraMeta={}, keyOverride=null, getTask=null)
                                                  // 注册占位 + task:register 双路 + 竞态补 resolve
resolveDeferred(bus, task, getTask?)              // 内部逻辑；普通任务现在由 dl-nextturn 负责
```

**内部细节**：
- `FINAL_RESOLVE_DELAY_MS = 2_000`（L105）：终态后延迟复查窗口。仅覆盖"wait 续注册后任务完成、agent 又回查拿到终态"窄间隙（v0.5.7 定稿后场景已极小）。
- 投递短路：
  - `task._delivered === true || task.delivered === true` → 直接 return（防 onload 兜底 / 注册竞态补 resolve 对"已同步投递"二次 resolve）
  - `task.consumedByWait || (task.waitActive||0) > 0` → return（Agent 已拿到/正在拿，静默）
- 非终态 → 直接 return
- 内部 `notifyRegistryFinal` 桥接 `lib/registry.js`：
  - `done` → `task:complete`
  - `canceled` → `task:cancel`
  - `failed`/`interrupted` → `task:fail`
- 占位不存在 → `.catch(() => {})` 静默（幂等设计）

**模块依赖**：`./registry.js`（registerTask/completeTask/failTask/cancelTask）

### 2.3 `lib/registry.js`

**职责（注释 L1-2）**：宿主 TaskRegistry 双注册封装。让宿主能 query/等/cancel 下载任务实例。

**宿主协议清单（L7-14）**：
```
task:register-handler  注册 abort handler（type="download"，必须在任何 task:register 之前）
task:register          注册任务实例（taskId+type+会话关联）
task:complete          done 终结
task:cancel            canceled 终结（agent 主动取消）
task:fail              failed/interrupted 终结
```

**导出函数**：
```js
registerHandler(bus, getTaskManager)              // onload 一次注册
registerTask(bus, task, toolCtx?)                 // 终态直接跳过（FINAL dict）
completeTask(bus, taskId, result)
cancelTask(bus, taskId, reason)
failTask(bus, taskId, reason)
```

**关键实现规则**：
- handler.abort 签名 `abort: async (taskId) => {}`，幂等且不抛错；经 `manager.cancel(taskId, "user")` 走同条链路
- `manifest.json` 必须声明 `["task.write", "task.read"]` 才能注册（plugins declared today L29-30 ✓）
- 不自带对 `deferred.js` 的 import（避免循环依赖），bus 兜底与 deferred.js 同口径
- 所有失败 `safeLog` + catch（容错；不阻断下载或通知）
- 终态任务重复调用 registerTask 直接 skip —— 宿主会强制把 status 从 completed 重置回 running（bug 防护）

### 2.4 `lib/progress-parsers.js`

**职责**：git clone / pnpm install 命令型任务的**纯函数输出行解析器**。

**导出函数**：
```js
parseGitLine(line) → {stage, pct, received, total, unit, message} | null
createPnpmParser()  → function(line) → ...        // 工厂：返回闭包（按 packages 计数）
```

解析规则：
- **git clone**：stderr 行 → cloning/enumerating/receiving/resolving/checkout 五阶段
- **pnpm install**：stdout `\r` 重绘 → 闭包状态化解析 resolving-deps/fetching/linking/building/finalizing（received 不累加，直接赋值）

无状态依赖外部，纯函数式 + 工厂模式。

### 2.5 lib 层模块依赖图

```
lib/dlcore.js ──┐
                ├── 动态 import ./progress-parsers.js
lib/registry.js ┘
                 ↑
lib/deferred.js ──── registerTask/completeTask/failTask/cancelTask
                 ↑
routes/tools/extensions/index.js 调用面
```

- `dlcore.js` 不 import 任何其他 lib
- `deferred.js` → `registry.js` 单向依赖
- `registry.js` 叶子

---

## 3. `extensions/dl-nextturn.js` —— 投递层唯一权威

**核心定位（注释 L1-12）**：从零：下载完成 → 真正同步投递（steering queue）。**不再走 deferred/append**，而是把消息作为"未收束对话的下一条 input"送达。

**追踪路径**：`index.js` onload 时**不会**主动加载本扩展。扩展由宿主按 plugin extension 机制加载（在每 AgentSession 各加载一次 → per-session 实例，读进程级 `globalThis.__dlTaskMgr`），导出默认函数 `export default function (pi) {...}`。

> ⚠️ 历史注脚（来自 `踩坑记录.md`）：v0.7 起本扩展被定为"唯一权威"，但 per-session 加载 × 进程级 TaskManager 必然 fan-out；v0.7.2-7.3 加 `ownThisSession` + `captureSession` 修跨会话（sessionPath 归一化文件名匹配）。

### 3.1 初始化流程（`export default function(pi)` 内）

1. `mgr = globalThis.__dlTaskMgr`（必须已存在，否则扩展无意义）
2. `wired = new Set()` 防重复 wire
3. **会话归属捕获**：
   - `currentSessionId / currentSessionPath` 由 `captureSession(ctx)` 在事件回调里更新
   - `hookSessionEvents()` 监听 `tool_execution_start/end / turn_start / session_start / session_switch` —— 来自 `踩坑记录.md` 坑10/12：HFt facade 不暴露 sessionManager；唯一通路是 `pi.on("事件名", (_, ctx) => ctx.sessionManager.getSessionId/getSessionFile)`
   - `session_start` 可能错过（扩展晚于 session 启动），所以兜底用 `tool_execution_*`/`turn_start`
   - `session_start` 触发时打日志
4. **挂载稳定可靠捕获（v0.7.3 实锤关键）**：
   - `mgr.onFinal((task) => handleFinal(task).catch(...))` —— 即时终态捕获，不依赖任何轮询间隔
   - `mgr.onStall((task) => handleStall(task).catch(...))` —— 与 `index.js` 的 onStall 并列（多监听器 fan-out，靠 `_stallDelivered` 旗标互斥）
5. **残留占位清理（delivered-only purge）**：
   - 扫 `mgr.list()`：终态 + `t.delivered || t._delivered || t.consumedByWait` → 调 `bus.request("deferred:suppress", {taskId, reason:"residual cleanup by nextturn"})`
   - 故意**不碰未投递的终态任务**：那些必须走正常通道（见 §3.5 收束分界）
6. **初始扫描 wire 在途任务**：
   - 排除已终态；`wire(taskId, task)` 对每个未终态任务挂 `mgr.onceFinal(taskId)`
7. **800ms 文件尾部轮询保险**：
   - `setInterval(... 800)`：扫 tasks.json，对新出现的非终态任务补 wire（防扩展加载后到 onFinal 阶段之间的缝隙）
   - `pendingWake.size > 0` 时顺便驱动 `retryPendingWake()`（v0.8.5 重试驱动内化）

### 3.2 会话归属判定（`ownThisSession`，`extensions/dl-nextturn.js`）

```js
function ownThisSession(task) {
  if (currentSessionPath && task.sessionPath) {
    const a = String(currentSessionPath).split(/[\\/]/).pop();
    const b = String(task.sessionPath).split(/[\\/]/).pop();
    return !a || !b || a === b;
  }
  return true;  // fail-open：抓不到 session → 放行，避免误杀本会话
}
```

- 双 path 任一缺失 → **return true（fail-open）**：注释明确"不确定安全就别兜底，fail-open 比 fail-close 风险低"
- `sessionId` 兜底分支已被 v0.7.3 commit f1bb215 删除：内/外 id 格式天然不等，误杀本会话

### 3.3 投递通道（`steerViaBus`，v0.9.x 死磕版）

按注释 "v0.9.1 死磕：主通道 = session:send-custom + deliverCustomMessage({triggerTurn:true})"：

```js
async function steerViaBus(bus, pi, t, content, details) {
  // ① 主通道（宿主原生同步，不依赖 captured pi）
  bus.request("session:send-custom", {
    sessionPath, customType:"hana-background-result", content, display:false,
    triggerTurn:true, details: { schemaVersion:1, ...details }
  }, { caller: { pluginId:"download-progress" } })  // 归属要求 caller 非 plugin kind
  → res.ok && (mode==="triggerTurn" || mode==="followUp") → "delivered"

  // ② 备用：pi.sendMessage（仅 pi 有效时）
  pi.sendMessage({...}, { deliverAs:"steer" })
  → 失败 / 抛错 → 降级
}
```

**关键 channel 演进（来自 `docs/sync-mechanism.md` & `docs/six-quadrant-test.md`）**：
- v0.769 宿主有 `deferred:steer` 路由 → 直接同步
- v0.810 宿主删 `deferred:steer` + `deliverCustomMessage` isStreaming 分支硬编码 `"followUp"`
- v0.9.1 死磕：改走 `session:send-custom` + `triggerTurn:true`（宿主 `@953531` 非 streaming 时主动触发新 turn 来消费，不依赖 `isStreaming`）
- 实测教训（d51a13d6）：扩展捕获的 `pi` 在会话被替换/重载后**必 stale**（"This extension ctx is stale"）→ `pi.sendMessage` 经常降级为异步

### 3.4 投递确认与唤醒重试队列（v0.8.5 起）

**`probeDelivered`**：用 `deferred:query` 查 store 真状态 `delivered/deliverySuppressed/exists`。

**`deliverDeferredConfirmed`**：注册/resolve → 12×500ms（6s）确认窗循环查询：
- 已 `delivered && !suppressed` → return true
- `suppressed` 且 `k>=4 && k%4===0` → **`deferred:retry` 再武装**（重置 pending+清 suppression）+ 再 resolve
- 6s 内仍未确认 → `pendingWake.set(taskId, {...tries:0, nextAt:0})` 入队

**`pendingWake`** Map：会话事件 + 800ms 轮询双重驱动 `retryPendingWake()` 重试。
- `e.nextAt` 强制每条 15s 回退
- `e.tries` 计次；`tries >= 8` → 收队（不置旗，宿主 flush/下次 onload 兜底重试）
- **按宿主语义分支**（`extensions/dl-nextturn.js:retryPendingWake`）：
  - `delivered && !suppressed` → 确认收队 + `_delivered=true` + `markDelivered`
  - `aborted + deliverySuppressed` → 唯一允许 re-arm 救活的状态：`deferred:retry` 重置 + 再 resolve
  - `pending` → 没人 resolve 过，resolve 一次
  - `resolved/failed` 未送达 → **绝不碰**（v0.8.9 防止重置覆盖宿主 flushUndelivered 的自己重试，bug #5）
  - `BOOT_TS = Date.now()`：启动后 150s 内 `pendingWake` 不得 trust-flush 收队（v0.8.9b boot-window 持有，避免双端旗标同周期永远对不上）

### 3.5 `handleFinal` —— 终态投递完整流程

1. **同步占位**（v0.8.9c fix TOCTOU 双 steer）：进入函数后第一句 `task._hfClaimed = true` —— 同一 tick 内完成 查+置，避免两次 await 之间的检查窗口
2. 终态判定失败 → return
3. **2s 延迟**（`await sleep(2000)`）—— 让 onload 兜底 vs 扩展的串行化窗口错开
4. 复查：`getTask(taskId)`；已 delivered / 已 consumed / agent 主动取消 / not own session 各自短路
5. **store-probe**（防 v0.8.6 跨 realm 双投）：
   ```js
   for (let g = 0; g < 6; g++) {
     const q = await busQ.request("deferred:query", { taskId })
     if (q.delivered && q.deliverySuppressed !== true) yieldToBackstop = true;
     if (q.status === "pending" && g >= 1) break;
     if (q.status === "aborted") break;
     await sleep(500);
   }
   ```
6. **`tailSettled(t.sessionPath)`** —— 真实收束判定（不是看尾行，而是从尾部往前扫，跳过 custom/turn_input_consumption 等记账条目，找真实 message `assistant+stopReason=="stop"`）
7. **分叉**：
   - **settled（已收束）** → `deliverDeferredConfirmed` 走异步 deferred，**不 suppress**（宿主需要投）
   - **unsettled（未收束）** → `steerViaBus` 走同步：
     - 成功 `"delivered"` → `_delivered=true` + `markDelivered` + `deferred:suppress` 占位（防宿主收束后再投）——**这是核心双投防护**（注释强调："suppressDelivery marks delivered+suppressed (status→aborted)"）
     - `"notifyOnly"` → 还旗（v0.8.5 不盲置旗）：
       - tail 判定竞态窗口里宿主实际空闲 → `deliverDeferredConfirmed` 异步确认投递（不盲置旗）
     - `pi.sendMessage({deliverAs:"steer"})` 降级（注释："未打补丁的 bundle 上它只对加载时所在会话有效"）
     - 降级抛 stale err → 也走 `deliverDeferredConfirmed` 异步兑底

**关键单投铁律**：
- 同步成功 → **`deferred:suppress`**（v0.9.0 注释：宿主无此路由，但代码中 `.catch(() => {})` 静默无害；功能靠"既不 resolve（已 deliver）也不被宿主再探活"实现）
- 异步成功 → **不 suppress**（让宿主投）
- `_delivered` + `markDelivered` 双重旗标同步
- 与 `index.js` 兜底（6s 延迟复查）的"v0.8.7 兑底串行化"协调：扩展先跑（onFinal→+2s）+ 兑底 6s 间隔

### 3.6 `handleStall` —— 停滞双通道（同样的 unsettled→steer, settled→让位）

- 同 `handleFinal` 入口短路（同会话/已投/已消费）
- **`tailSettled` 收束时让位**（v0.8.3）：绝不在已收束时抢旗——`stallKey` 是从未注册占位的虚 key，`index.js onStall` 的成对注册+解析才是 settled 路径的权威对；这里抢会让 `index.js` 的补查阶段还活 own 占位 → 双双落空（用例4 8610bdf3 实锤）
- unsettled：
  - `t._stallDelivered = true`（占位窗口）
  - `steerViaBus` 同步
  - 成功 → `deferred:suppress` 熄 stallKey
  - 失败/`notifyOnly`/pi stale → **还旗**（v0.8.3 fallback 修正："stall STEER ERR → release flag, index.js deferred owns it"）

### 3.7 `wire()` —— onceFinal 挂载

```js
function wire(taskId, task) {
  if (wired.has(taskId)) return;        // 防重挂
  if (!ownThisSession(task)) return;    // 闸门前移（v0.7.3 commit f1bb215）
  wired.add(taskId);
  mgr.onceFinal(taskId).promise.then((t) => handleFinal(t || task)).catch(noop);
}
```

- **闸门前移到 wire**（v0.7.3）：不通过 → 不挂 onceFinal，从源头断 fan-out
- `onceFinal` 返回 `{ promise, cancel }`，但本扩展**没用 cancel**——意味着 setInterval 800ms 重扫时即使 set 已大也只是 promise 链挂在那

### 3.8 模块依赖

- `globalThis.__dlTaskMgr`（dlcore 单例）
- `pi`（per-session 手柄；多数场景 stale）
- `bus`（来自 `lib/deferred.js:getBus()` 全局兜底）
- `lib/deferred.js:registerDeferred`（仅占位不存在补注册路径用）

---

## 4. app/ 前端层（iframe 内运行）

### 4.1 `app/card.js` —— 单下载任务卡片

**职责**：单任务进度卡片 webview，前端轮询 `/download/status` 拿最新状态并渲染。

**关键技术细节**：

- **mini host SDK**（自实现，`@hana/plugin-sdk` 协议兼容，免构建）：
  ```js
  window.__API = "..."; (由 routes/download.js 注入)
  PARENT.postMessage({ protocol:"hana.plugin.ui", version:1, kind:"request"|"event", type, payload }, HOST_ORIGIN)
  ```
  - request 配 8s 超时 + seq 序号精确匹配 + 来源 source 验证
  - HOST_ORIGIN 从 URLSearchParams 拿（防 Electron referrer=file:// origin="null"）
- **主题跟随**（自包含）：
  - 启动时读 `data-hana-theme` 静态值 → 缺失时 fallback `prefers-color-scheme`
  - 监听 `hana.theme.changed` / `theme-changed` postMessage → 更新 `data-hana-theme` + `t-dark` class（这整条链路依赖宿主 `lib/theme.js` 补丁 `patch/patch-theme-0.680.21.js`）
  - `matchMedia('(prefers-color-scheme: dark)').addEventListener('change')` 跟随系统切换
- **内容高度自适应**：
  - ResizeObserver 监听 `#dl-root`（不监听 body：高度变化会让 body scrollHeight 变 → 循环报高）
  - `measureH()` 取 `.dl.offsetHeight + body.padding`
  - 上限 470px（用户 2026-08-31 要求，宿主 >520 时卡片 470 上限，右侧留白）
- **轮询**：
  ```js
  function poll() { fetch("/download/status?taskId=..."); ... render(data.task); if (terminal) stop(); }
  timer = setInterval(poll, 600);
  ```
- **BroadcastChannel**："全部展开"按钮跨卡片同步折叠状态（`hana-dl-cards` channel）
- **操作**：取消（卡片按钮）/ 打开文件 / 打开文件夹 / 复制路径（hostRequest `clipboard.writeText`）
- **命令型任务 unit 渲染**：unit ∈ `objects/files/packages` 走"X/Y 单位"格式（如 `120/300 对象`），不走字节格式化
- **停滞视觉**：`b-stalled` 徽标 + `连接停滞，等待 Agent 决策`

**对应 CSS `app/card.css`**：
- 自包含浅/深两套色板（`--dl-bg` `#FCFAF5` 浅 / `--dl-bg` `#445560` 深，挂在 `body.t-dark` 切换）
- 进度条 `.dl-bar.indet` 流动动画 / `.dl-bar.done` 绿色 / `.dl-bar.failed/.canceled/.interrupted` 红色
- `overflow:hidden; max-width:470px` 外层硬边界（防内容溢出抖动）
- `font-variant-numeric: tabular-nums` 速度/大小对齐
- 详情区 `.dl-detail` 折叠展开（CSS display 切换，不用 max-height 钳位——v0.8.31 起全自适应）

### 4.2 `app/manager.js` —— 跨会话下载管理器（独立 webview）

**职责**：扫所有 Agent 会话的下载任务；列表 + 筛选 + 搜索 + 详情 + 操作。

**关键技术细节**：

- 主题/主题跟随 / mini host SDK / 自包含色板 / iframe URL token —— 与 `card.js` 同口径
- **轮询**：`setInterval(poll, 3000)` → `/download/list` 拿所有任务快照
- **筛选**：
  - 4 个分类按钮：`all`/`active`/`done`/`failed` —— `filter === "active"` = running+pending；`failed` 含 failed/canceled/interrupted
  - 双击分类按钮弹出下拉（`openFilterMenu`）：
    - 全部 → 清空全部终态
    - 在途 → 全部取消
    - 完成 → 清空 done
    - 失败/取消 → 清空 failed/canceled/interrupted
- **搜索**：文件名 / URL / 路径 / error 文本即时筛选
- **行内操作**：
  - 主按钮"打开" → `/download/reveal` mode=open（默认程序）
  - 下拉箭头 → 打开文件 / 打开所在文件夹
  - 在途任务 → 额外"取消"按钮
- **详情展开**：`expanded === taskId` 切换；显示 taskId/URL/savePath/session/startedAt/finishedAt/elapsed/state
- **设置菜单**：
  - 两个互斥选项：
    - 设置默认下载目录（→ `hostRequest("resource.pick", {mode:"directory"})`，宿主不可用回退 `prompt`）
    - Agent 自选（每次下载带 saveDir 走 toolCtx）
  - 写到后端的 `/settings` → `dataDir/config.json`
- **状态底色**：完成淡绿 / 失败淡红；进行中任务行有"整行进度背景层"（`.mgr-row-bg`）按百分比铺底 + 流动动画

**对应 CSS `app/manager.css`**：
- 自包含两套色板（同 card.css 思路但独立变量集 `--mgr-*`）
- 衬线字体（Noto Serif SC / Songti SC）主区 + 仅统计行 `.mgr-counts` 改无衬线（去掉衬线塑料感）
- 整行进度背景层（`.mgr-row-bg`） `position:absolute; inset:0` + 渐变动画
- `body.t-dark` 时变量全局切深色板

**两个前端层都没有任何外部 JS 依赖**（纯 vanilla JS + CSS），不需要构建步骤。

---

## 5. routes/ 与 tools/

### 5.1 `routes/download.js` —— 全部路由

**注册入口**：`export default function registerDownloadRoutes(app, ctx)` → 由宿主插件加载器在启动时挂载到 `/api/plugins/${ctx.pluginId}/...`。

**所有路由**：

| Method+Path | 行 | 用途 |
|---|---|---|
| `GET /settings` | ~58 | 读插件 `dataDir/config.json` |
| `POST /settings` | ~66 | 写 defaultSaveDir / agentChooses（互斥语义：设默认目录自动取消 agent 自选，反之亦然） |
| `POST /download/start` | ~88 | UI 入口创建任务（**sessionId=null**，不注册 deferred 占位，无唤醒语义） |
| `POST /download/prepare` | ~106 | UI 入口 pending 占位 + 延迟启动（同上 sessionId=null） |
| `GET /download/status?taskId=` | ~125 | 卡片轮询，返回 `snapshot(taskId)` |
| `GET /download/list` | ~138 | 管理器轮询，返回所有任务快照（在途优先 + 终态倒序） |
| `POST /download/cancel?taskId=` | ~145 | 取消（`source="user"` 卡片按钮固定） |
| `POST /download/clear` | ~155 | 管理器分类清空（`body.states`） |
| `POST /download/cancel-all` | ~170 | 管理器全部取消（`cancelAll("user")`） |
| `POST /download/reveal` | ~178 | **服务端 `explorer.exe` 路径**：`mode="open"` 默认程序打开 / `mode="reveal"` 打开所在文件夹；含路径安全校验（必须在任务记录中）+ Windows cmd /c + `"…"` + `^` 转义 + `windowsVerbatimArguments:true`（绕过宿主 platform 限制 + 防注入面） |
| `GET /manager` | ~207 | 返回管理器页 HTML（无 cache，每次重读 css/js） |
| `GET /card/download` | ~230 | 返回卡片页 HTML（无 cache，每次重读 + 嵌 css/js）；**无 taskId 时自动选 in-progress 优先，否则最新**（Chalkboard 卡片静态 route 用） |

**关键实现细节**：
- `_freshManager(dataDir)`：检查 `typeof m.clearByStates === "function"` —— 缺新方法时 `_resetTaskManager()` 重建（绕开插件加载器对 lib 模块缓存）
- `readCardAssets / readManagerAssets`：每次请求重读 css/js，避免宿主 cache
- HTML 注入通过 `esc()` helper（防 XSS）
- `dataDir/config.json` 不只是设置：也会被 `lib/dlcore.js:resolveProxy` 读 `proxy` 字段

### 5.2 tools/

| 文件 | 名称导出 | sessionPermission | 关键逻辑 |
|---|---|---|---|
| `download-file.js` | `name = "download-file"` | `{kind:"external_side_effect"}` | URL 校验 → `getTaskManager` → 解析 saveDir（优先级：用户传入 > config.defaultSaveDir / agentChooses 模式 > 系统配置 fallback）→ `manager.prepare({...,sessionId, sessionPath: sessionPath || sessionRef?.path})` → **`registerDeferred`（创建即注册）** → 返回 `details.card = {type:"webview", route, title, titlebar:null, cardForm:"flush"}` |
| `download-command.js` | `name = "download-command"` | `{kind:"external_side_effect"}` | 白名单命令（git-clone / pnpm-install）→ 不做 shell 拼接，spawn 数组传参 → 参数组装（git-clone 需要 repo+targetDir；pnpm-install 需要 workdir）→ `manager.prepare({kind:"command", cmd, unit, ...})` → `registerDeferred` |
| `download-wait.js` | `name = "download-wait"` | `{kind:"read"}` | v0.8 起**纯事实快照**（已不再守望）：最多 5s 循环等 total 出现 → 已终态 → `markConsumedByWait` + **`deferred:suppress`**（确认 Agent 拿到）+ 立即返回 done；未终态 → `ensureDeferred` 续注册占位（v0.5.7 注册时机口径）→ 返回事实 + 注册状态指引 |
| `download-cancel.js` | `name = "download-cancel"` | `{kind:"external_side_effect"}` | `manager.cancel(taskId, "agent")` —— 与卡片按钮 cancel（`source="user"`）区分；行为对齐实际：字节流 `.part` 保留 / 命令型半成品目录清 |

**所有工具共同模式**：拿 `toolCtx.dataDir` → `getTaskManager(toolCtx.dataDir)` → 检查或创建任务 → 必要 `registerDeferred(toolCtx.bus, ...)`。

**tools/ 中已停用**：
- `dl-recon.js` —— 文件注释："B' 方案最小验证"；当前**实际未被插件加载**（无 `name` 导出；纯 `node script`）；功能已被 `extensions/dl-nextturn.js` 内部 800ms 轮询 + `onFinal` 完全取代。
- 用户列出的 `dl-native-probe.js` 在装机目录**不存在**（零 grep 命中），可能是其历史原型名（前代勘探脚本）。

---

## 6. 模块间数据流总图

```
                          ┌────────────────────────────────────┐
                          │ 用户/宿主/Agent                      │
                          └────────────────────────────────────┘
                                       ↓ ↕
   ┌─────────────────────── 宿 主 bus（deferred:*/task:*/session:send*）───────────────┐
   │                                                                            ↓      │
   │              ┌────────────────┐                                  ┌─────────────────┐│
   │              │ tools/         │ 注册占位                           │ extensions/      ││
   │              │ download-file  │ registerDeferred()─────┐         │ dl-nextturn.js  ││
   │              │ download-command│                       ↓         │ (per-session)  ││
   │              │ download-wait  │               ┌────────────────┐  │                ││
   │              │ download-cancel│               │ lib/deferred.js│  │ 捕获 onFinal   ││
   │              └────────────────┘               │ (resolve logic)│  │ onStall        ││
   │                    │                          └────────────────┘  │ ownThisSession ││
   │                    ↓                                ↓              │ tailSettled    ││
   │            ┌──────────────────┐              ┌────────────────┐  │ steerViaBus    ││
   │            │ routes/download.js │              │ lib/registry.js│  │ pendingWake    ││
   │            │ (HTTP API)        │              │ (TaskRegistry)  │  └────────────────┘│
   │            └──────────────────┘              └────────────────┘       ↓             │
   │                    ↓                                  ↑            globalThis.       │
   │            ┌──────────────────┐            registerTask             __dlTaskMgr      │
   │            │ app/card.js       │                              ┌─────────────────┐ │
   │            │ app/manager.js   │ 轮询                          │ lib/dlcore.js  │←┘
   │            │ (iframe webview)  │↓                              │ TaskManager     │
   │            └──────────────────┘                               │ _run/_runCommand│
   │                                                                │ cancel/snapshot │
   │                                                                │ onFinal/onStall │
   │                                                                │ restore/_persist│
   │                                                                └─────────────────┘
   │                                                                        ↓
   │                                                       D:\HanakoWorks\...\.hanako\plugin-data\
   │                                                       download-progress\{tasks.json, config.json,
   │                                                       speed-cache.json, downloads\}
   └────────────────────────────────────────────────────────────────────────────────────────────┘
```

**消息流叙述**（一个典型下载-完成-通知流程）：

1. **发起**（chat 内 LLM 调工具）：
   - `tools/download-file.js → execute()` —— 校验 url → `manager.prepare({...sessionPath})` 创建 pending 任务并延迟启动 → `registerDeferred(toolCtx.bus, task, {})` 注册占位 + task:register 双路 → 返回 `details.card = {route: "/card/download?taskId=..."}`
   - 宿主将卡片挂到工具块正下方（iframe webview，`hana.plugin.ui` 协议）

2. **下载执行**（`dlcore:_run`/`_runCommand`）：
   - 流式下载 + 5s 间隔停滞 monitor + 进度限速 + SHA-256 校验（如有）
   - 终态到达 → `_fireFinal(task)` → 触发所有 `_finalWaiters` 的 promise（扩展 wire 时已挂 `onceFinal`）
   - 终态到达 + 停滞 → `_fireStall(task)` → 触发 `index.js onStall` + 扩展 onStall 多监听器
   - `_persist()` 写 tasks.json（version=3 schema，只保留最近 100 终态）

3. **投递权威判定**（`extensions/dl-nextturn.js:handleFinal`）：
   - `task._hfClaimed = true`（TOCTOU 防双 steer）
   - `await sleep(2000)`（让 onload 兜底窗口错开）
   - `getTask(taskId)` + 复查 `consumedByWait / waitActive / canceledBy === "agent"` 短路
   - `store-probe`（v0.8.6 跨 realm 双投防护）6 轮 `deferred:query`
   - `tailSettled(t.sessionPath)` 真实判定 jsonl 收束
   - **settled** → `deliverDeferredConfirmed` 异步 deferred + suppress 跳过；**unsettled** → `steerViaBus` 同步：① `session:send-custom + triggerTurn:true` 主通道 ② `pi.sendMessage({deliverAs:"steer"})` 备用 ③ → deferred:resolve 兑底
   - 同步成功 → `_delivered=true` + `markDelivered` + **`deferred:suppress`**（防宿主异步再投）

4. **残留补投**（`index.js onload setTimeout 6s`）：
   - 扫 `mgr.list()` 终态任务，跳过已 delivered / 已 consumed / 已 store-delivered
   - 未投递 + 已注册占位 → `resolveDeferred(bus, t)`
   - 未投递 + 未注册 + 有 sessionPath → `registerDeferred(bus, t, {}, null)`（内部对终态任务立即 resolve）

5. **后续操作**：
   - 用户点卡片"取消" → iframe `cancel()` → `POST /download/cancel?taskId=` → routes → `manager.cancel(id, "user")` → 落 canceled，触发 onFinal → 第 3 步走一遍
   - 用户点"打开文件夹" → iframe `openFolder()` → `POST /download/reveal` → 路径校验 + `cmd /c explorer.exe "<path>"`（带 `^` 转义 + windowsVerbatimArguments）
   - 宿主 `stop_task(taskId)` → 命中 `task:register-handler` → `manager.cancel(taskId, "user")`
   - Agent 用 `download-wait` → `markConsumedByWait` + `deferred:suppress`（v0.8.2 确定性熄占位）→ 立即快照返回

**两条独立权威**（明确分工）：
- **正常收束后**：`extensions/dl-nextturn.js` 是**唯一权威**（单投铁律）
- **boot 缝隙 / 兜底**：`index.js onload setTimeout 6s` 是**兜底权威**（仅扩展未投时补一手）
- **收束态 stall**：`index.js onStall` 注册+解析路径（stallKey 从未注册，必须"成对"才生效），扩展**让位不抢**（v0.8.3 防双占位）

---

## 7. 当前版本号确认（这是装机版，不是历史推断）

### 7.1 多版本号矛盾点

| 来源 | 声明 | 备注 |
|---|---|---|
| `package.json` | `"version": "0.9.0"` | 装机 source code 顶部权威 |
| `manifest.json` | `"version": "0.9.0"` | 宿主加载插件时读此字段 |
| `index.js:log.info` | `download-progress v0.9.0 loaded (downloads → ${...})` | 实际启动日志 |
| `README.md` 头部 | **"当前版本：v0.9.2"** | 文档声明 |
| `PROJECT_REQUIREMENTS.md §10` | "下一步（本轮遗留）：版本 bump 到 v0.9.2，打包" | **明确标注 v0.9.2 是未完成的下一步** |
| `extensions/dl-nextturn.js` 注释 | "v0.9.1 死磕" / "v0.8.5" / "v0.8.9" / "v0.8.7" "v0.8.2" "v0.8.3" "v0.8.4" "v0.8.6" "v0.8.9b" "v0.8.9c" | **内部修改点历史注释，非版本号字段** |
| `lib/dlcore.js:MGR_VER = 20` | "v20=加 clearByStates/cancelAll" | **模块单例版本哨兵**，不是插件版本号 |

### 7.2 真实装机版本

`package.json` / `manifest.json` / `index.js log.info` 三方一致声明：**v0.9.0**。

- README 头部 v0.9.2 是已规划但**未完成的下一版**（PROJECT_REQUIREMENTS §10 明示）
- 0.9.0→0.9.2 的增量（按 PROJECT_REQUIREMENTS + docs/）：投递层收敛为 host-native-first（移除 `deferred:steer/suppress/steeringQueue` 死路依赖，全部六象限回归 + 宿主升级时重做 patch）
- 代码注释里频繁出现的"v0.8.x" "v0.9.1" 是**演进历程标注**，不是当前插件版本
- `MGR_VER = 20` 是 `dlcore.js` 单例哨兵（数值不与 plugin 绑定，但历史上有过数 1→20 演进，未来改 dlcore 逻辑会继续 +1）

### 7.3 当前装机版的关键版本特征汇总

- **0.9.0 baseline**（v0.8.7+ 系列修复聚合），行为重点：
  - `dl-nextturn.js:steerViaBus` 主通道采用 `session:send-custom + triggerTurn:true`（v0.9.1 死磕）
  - `_delivered` 内存旗 + `markDelivered` 持久化双旗
  - `BOOT_TS = Date.now()` + 150s boot-window 持有
  - 800ms 轮询 `tasks.json` 保险
  - 6s 后 onload 兜底（v0.8.7 兑底串行化）
  - 投递时 store-probe 6 轮（v0.8.6 跨 realm 防双投）
  - 收束判定用 `tailSettled` 跳过 turn_input_consumption 等记账条目
  - 多监听器 onStall（index.js + dl-nextturn 双 fan-out）
  - `session:send` / `pi.sendMessage` 失败 → `deliverDeferredConfirmed` 兑底
  - `consumedByWait` + `waitActive` 守望计数 + `_resolveTimer` cancel

---

## 8. 一句话总结（用户要的 200 字结论）

当前装机 `download-progress v0.9.0`：单进程级 `TaskManager` 单例（`dlcore.js`，49.9KB HTTP/Range/SHA256/限速/停滞/持久化），按 Manifest 暴露两个 webview（`/card/download`、`/manager`）+ 四个 LLM 工具（`download-file/-command/-wait/-cancel`）。**投递是双通道机制**：`extensions/dl-nextturn.js` 是未收束侧主通道（`session:send-custom+triggerTurn` 同回合 steer，pi stale 时降级）和收束侧异步通道（`deferred:resolve` + confirm+retry + `pendingWake` 队列），以 `_delivered/markDelivered/delivered/store-delivered` 四层旗防双投；`lib/deferred.js` 是占位 helper（register+竞态补 resolve+consumedByWait 静默），`lib/registry.js` 双注册 `task:register/complete/cancel/fail` 让宿主 `stop_task` 可取消。`lib/progress-parsers.js` 给 git/pnpm 命令型任务做 stdout 解析。`index.js onload` 跑遗留 interrupted 恢复 + `mgr.onStall` 兜底占位托管 + 6s 兑底扫描（与扩展按 2s/6s 串行化分工防双投）。UI 是自包含 iframe（`card.js` 单任务轮询 600ms、`manager.js` 跨会话轮询 3s + 筛选 + 搜索 + reveal + 默认目录设置），自包含浅/深色板跟随宿主（依赖 `patch/patch-theme-0.680.21.js` 给宿主 theme.js 加的广播）。无第三方依赖、纯 Node 18+ + vanilla JS。版本号 `package.json`/`manifest.json`/`log.info` 三方均为 0.9.0；README/REQUIREMENTS 提到的 0.9.2 是已规划的下一站（投递层收敛为 host-native-first + 全量六象限回归，详见 `docs/six-quadrant-test.md` 与 `docs/sync-mechanism.md`）。用户提的 `tools/dl-native-probe.js` 当前目录不存在，零 grep 命中，最可能是 `tools/dl-recon.js` 在迭代中的代号，`dl-nextturn.js` 内部 800ms 轮询已完全替代它的职能。
