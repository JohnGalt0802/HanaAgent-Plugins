# v2 升级记录（v1 插件契约 → manifestVersion: 2）

> 落盘时间：2026-09-01
> 版本：0.9.3 → 0.10.0（v2 契约 = 大版本变更）
> 目的：升级 hana-downloader 到 v2 插件契约，解决 sync-first 双投 bug（stallKey 走
> triggerTurn 异步通道 + done 走 steer 同步通道 → 双投）。
> 依据：宿主 0.814.0 `bundle/index.js`（**运行中的宿主**，`.verified` 已激活、`hana-server.cmd`
> 加载该 bundle）+ `app-host-entry.js` + `skills2set/hana-plugin-creator` 官方 v2 脚手架
> （`scripts/create_hana_app.py`）+ SDK tarball 解包对照。

---

## 0. 结论速览（先看这里）

| 项 | 结论 | 证据 |
|---|---|---|
| 宿主 v2 要求 | `manifestVersion` **必须恰为 2**，v1 manifest 在 v2 加载器下直接 unusable | bundle `no = 2`；`LBt()` 抛 `manifestVersion must be exactly 2, got 1` |
| manifest 入口字段 | v2 用 **`entry`**（不是 v1 的 `main`） | `LBt()` 读 `i.entry`，报错 `entry must be a non-empty string` |
| v2 入口形态 | ESM，`export default { name, apply }`（或直接导出 apply 函数） | `app-host-entry.js` `resolvePluginApply()`：解包 `default.apply`；`import(entryUrl)` 加载 |
| apply(ctx) 成员 | `tools / logger / bus / userInteraction / inputBanner / config / commands / hooks / network / routes / dataDir / resources` | `plugin-context-v2.ts`（bundle 内）`Object.freeze({...})` |
| ctx.tools.register | **单对象签名** `register({name, description, parameters, execute})`，不是 `(name, def)`；参数键是 `parameters`（不是 v1 的 `inputSchema`） | `plugin-context-v2.ts` tools door |
| verified v2 caller | ✅ v2 `ctx.bus.request` 自动盖章 `caller:{pluginId}`（**无 kind**）→ 过宿主 `Zi()`（`Zi` 只拒 `kind==="plugin"`） | `hub/index.ts` session:send 分支 + v2 bus proxy |
| 真同步通道 | `session:send` + `deliverAs:"steer"` + 流式 → `OD()` 同步注入（同回合读到）；收束 → submitDesktopSessionMessage 唤醒 | `hub/index.ts` session:send handler |
| session:send-custom | 要求 **verified v2 caller**（v1 caller `kind:"plugin"` 被拒 ERR）→ `deliverCustomMessage`：流式 followUp / 收束 triggerTurn | `hub/index.ts` session:send-custom handler |
| `deferred:list-resolved` | **宿主 0.810/0.814 全量 bundle 不存在**（register/retry/resolve/fail/query/list-pending/abort 之外无 list-resolved） | 全文件字符串扫描 |
| v2 bus allowlist | `ctx.bus.request` 只放行 19 个 verb（`session:*` 11 个 + `agent:*` 4 个 + `model:list` + `app:capabilities` + `session:send-custom`…）；**`deferred:*` / `task:*` 一律拒绝** | `APP_BUS_REQUEST_ALLOWLIST`（bundle `UDe`/`Tae`） |
| 归属校验 | stock 宿主 `_c()` 内 `IAr()`：verified caller 只能 session:send/send-custom **自家 app 拥有的会话**（`ownerPluginId === appId`），普通用户会话 → `does not belong to app` | `hub/index.ts` `_c` + `IAr`；与 `docs/sync-mechanism.md` 0.810 实测一致 |
| 双投根治 | done 与 stallKey 改走**同一条** verified-caller 通道（不再一个 steer 一个 deferred） | 本版本 dl-nextturn 改动 |

⚠️ **最重要的一个坑**：stock 0.814 宿主的 `IAr` 归属校验会拒绝 v2 app 往**普通用户会话**
投递（`does not belong to app`）。这与 `docs/sync-mechanism.md` 第 4 节 0.810 实测
（"v2 session:send/send-custom → caller 通过，但归属校验只允许发自家 plugin session"）一致。
**若当前运行宿主（可能是魔改 build，bundle hash ≠ .verified）已放开该校验，则 v2 双通道成立；
若未放开，则 v2 下也无法往用户会话做同回合同步投递**——需要宿主侧放开（魔改）或让下载会话
归本 app 所有（`ownerPluginId`）。请以实测定夺（本版本代码已按「宿主放开」的假设实现，并保留
send-custom → deferred 逐级防御，任何一级被拒都有日志可查）。

---

## 1. 改动清单

| 文件 | 改动 |
|---|---|
| `manifest.json` | v1 → v2：`manifestVersion: 2`、`entry: "index.js"`（替代 `main`）、version `0.10.0`；移除 `extensions / tools / dataDir / config`；**未写** `contributes.cards`（见 §4.4）、`trust`、`ui`、`author`、`capabilities` 收窄为 `["tools"]` |
| `index.js` | v1 `export default class … onload()` → v2 ESM 入口：`export function apply(ctx)` + `export default { name, apply }`；apply 内构建 TaskManager + `manager.restore()` + `globalThis.__dlBus` + `registerHandler`（容错降级）+ `createDelivery(ctx, manager)` |
| `extensions/dl-nextturn.js` | `export default function (pi)`（v1 pi 扩展）→ `export function createDelivery(ctx, mgr)`；同步通道重写：`sendSessionMessage`（session:send steer）→ `session:send-custom` → 防御 deferred；`abortAllstallKey` 保留 + 拒绝日志；`LOG` 落盘改到 `ctx.dataDir/nextturn.log`（子进程权限模型） |
| `package.json` | version `0.9.3` → `0.10.0`（`type: "module"` 保留——v2 入口经 `import()` 加载，必须 ESM） |
| `docs/v2-upgrade.md` | 本文档 |

未改（不在本任务范围，需后续迁移，见 §4.4）：`tools/*.js`（4 个下载工具）、`routes/download.js`、
`app/*` 卡片前端、`lib/*`（deferred/registry/dlcore 内部对 `deferred:*`/`task:*` 的调用保留原样，
在 v2 allowlist 下由各函数自带 try/catch 静默降级）。

---

## 2. v1 → v2 契约变化（宿主源码实证）

### 2.1 manifest

```jsonc
// v1（旧）
{
  "manifestVersion": 1,
  "main": "index.js",
  "extensions": [...], "tools": [...], "dataDir": ..., "config": ...,
  "contributes": { "cards": [...], "configuration": {...} },
  "trust": "full-access", "capabilities": ["task.write", "task.read"],
  "ui": { "hostCapabilities": [...] }, "author": "..."
}

// v2（新，本插件）
{
  "manifestVersion": 2,          // 宿主 LBt：必须恰为 2
  "id": "hana-downloader",     // 必须等于目录名（apps/hana-downloader/）
  "name": "Hana Download Manager",
  "version": "0.10.0",
  "description": "...",
  "minAppVersion": "0.158.0",
  "entry": "index.js",           // v2 入口字段（不是 main）
  "capabilities": ["tools"]      // v2 下为信息性（权限闸走 app/* 能力）
}
```

- v2 顶层字段白名单（bundle `hOe`）：`manifestVersion/id/name/version/description/minAppVersion/trust/hidden/activationEvents/capabilities/sensitiveCapabilities/permissions/network/formFactors/ui/contributes/dev` —— **无 `author`、无 `extensions`、无 `tools`、无 `dataDir`、无 `config`**。
- `entry` 必须解析到插件目录**内部**（`entry must be a path inside the plugin's own directory`）。
- v2 插件装在 `<hanakoHome>/apps/<id>/`（v2 加载器 `plugin-loader-v2.ts` 扫描 `apps/`；`plugins-v2/` 旧目录会被 rename 迁移）。**从 `plugins/` 目录升级 v2 时需挪到 `apps/`**。

### 2.2 入口加载（app-host-entry.js）

```js
// 子进程内（Node permission model：--allow-fs-read=installDir,dataDir --allow-fs-write=dataDir）
exports = await import(pathToFileURL(entryPath).href);
const pluginApply = resolvePluginApply(exports, basename(entryPath)); // 解包 default.apply
await pluginApply(ctx);   // ctx = v2 五成员（+config/commands/hooks/network/routes/resources）
```

`resolvePluginApply`：`exports.default` 为函数 / 带 `apply` 的对象 → 用之；否则报
`does not export a v2 plugin: a plugin entry exports an apply function`。

### 2.3 apply(ctx) 成员（plugin-context-v2.ts）

```js
Object.freeze({
  appEvents, tools, logger, bus, userInteraction, inputBanner,
  config, commands, hooks, network, routes, dataDir, resources
})
```

- `ctx.tools.register(def)`：`{ name, description, parameters, execute(input, ctx) }`，返回 disposer；另有 `listOwn()`。
- `ctx.bus.request(type, payload, options)`：**自动盖章 `caller: { pluginId }`**（覆盖插件传入的 caller）→ verified v2 caller。allowlist 见 §2.4。
- `ctx.userInteraction.ask({ sessionPath, title, ... })` / `ctx.inputBanner.set/dismiss`（本版本未使用，记录契约）。
- `ctx.logger.info/warn/error/debug`。

### 2.4 ctx.bus.request allowlist（`APP_BUS_REQUEST_ALLOWLIST`）

放行（19 个）：`session:create / session:get / session:send / session:update / session:abort /
session:history / session:tools / session:list / session:send-custom / session:append-entry /
session:set-entry-label / session:get-entry-label / session:switch-model / agent:create-from-type /
agent:list / agent:update / agent:update-config / model:list / app:capabilities`。

**拒绝**：`deferred:*`、`task:*`、`agent:create/profile/config`、`provider:*`、`media:*`、`usage:*`、`model:*`（除 list）等。
→ 影响：
- `lib/registry.js` 的 `task:register-handler / task:register / task:complete / task:fail / task:cancel` 全部被拒（函数内 try/catch + `safeLog` 降级）。
- `lib/deferred.js` 的 `deferred:register / resolve` 被拒（防御通道，见 §3.3）。
- 投递主通道（session:send / session:send-custom）在 allowlist 内 ✅。

### 2.5 verified caller 与真同步（hub/index.ts）

```js
function Zi(caller) { return !caller || typeof caller != "object" || caller.kind === "plugin" ? null : caller.pluginId; }
```

- v1 插件总线盖章 `caller:{kind:"plugin", pluginId}` → `Zi` 返回 null → **非 verified**：
  - `session:send` → 非 verified 分支（流式直接 `session_busy`）→ 这就是 v1 里 PI-STEER 以外的通道全堵的根因；
  - `session:send-custom` → 直接抛 `session:send-custom requires a verified v2 app caller identity`（= 用户说的"v1 验证 v2 caller 时报 ERR"）。
- v2 `ctx.bus.request` 盖章 `caller:{pluginId}`（无 kind）→ `Zi` 返回 appId → **verified**：
  - `session:send` + `deliverAs:"steer"`：流式 → `OD()` **同回合同步注入**（真同步）；收束 → `submitDesktopSessionMessage`（桌面消息唤醒）。
  - `session:send-custom`：`deliverCustomMessage` → 流式 `mode=followUp`（进当前回合）/ 收束 `mode=triggerTurn`（custom entry + 唤醒）。

### 2.6 归属校验（`_c` 内 `IAr`）—— v2 投递的最大现实约束

所有 session:* handler 都经 `_c()` 解析会话，`_c()` 末尾对 verified caller 执行：

```js
const i = await listSessions({ includePluginPrivate: true, ownerPluginId: appId });
if (!(i.some(a => a.sessionId === t.sessionId || a.path === t.sessionPath)))
  throw new Error(`session ... does not belong to app "${appId}"`);
```

→ v2 app **只能往 `ownerPluginId === 本 app` 的会话**投递。普通用户会话（下载发生地）在 stock
宿主上会被拒。见 §0 结论速览的 ⚠️ 段与 §5「待验证」。

---

## 3. abortAllstallKey 修复尝试记录

### 3.1 list-pending 失效（v1 实测，用户提供 + 本文档复核）

- `deferred:list-pending` 只列出 **pending** 占位；stallKey 在 handleStall 里已
  `deferred:resolve` → 状态 resolved → 不在 list-pending → `abortAllstallKey` 匹配不到 → **完全无效**（实测结论，与代码语义一致）。

### 3.2 list-resolved 接口探查（本任务完成）

- 全量字符串扫描宿主 bundle（0.810.0 与 **0.814.0 运行中 bundle**）：`list-resolved` **不存在**。
- 宿主 deferred 动词全集（bundle `e.handle("deferred:*")` 枚举）：`register / retry / resolve / fail / query / list-pending / abort` —— 无 list-resolved、无 list-all、无按 session 查询的 resolved 列表。
- `deferred:query` 存在但只按 `taskId` 单查（`query(taskId)`），且 v2 allowlist 拒绝 `deferred:query`。

**结论：host 无 list-resolved。** 无法用"列出已 resolve 的 stallKey 再清"的思路修复。

### 3.3 v2 下的保留与降级（本版本实现）

- `abortAllstallKey(t)` 保留为防御：仍调 `deferred:list-pending` + `deferred:abort`；
  v2 allowlist 拒绝 `deferred:*` → 首次被拒时记一条日志：
  > `abortAllstallKey: deferred:list-pending 被拒（v2 allowlist 无 deferred:*，host 亦无 list-resolved 接口）→ abortAllstallKey 只能清理允许 deferred:* 的宿主（v1 通道/魔改宿主）上的 pending 占位`
- 双投的根治不依赖 abortAllstallKey：done 与 stallKey 改走**同一条** verified-caller 通道
  （§4.1），不再"一个 steer 同步 + 一个 deferred 异步"，从结构上消除双通道双投。

---

## 4. 本版本实现说明

### 4.1 dl-nextturn.js：v2 投递通道（sync-first）

```
handleFinal / handleStall
  └─ 未收束（tailSettled=false，v2 子进程读不到会话文件 → 恒 false，见 §5）
       ├─ ① sendSessionMessage(ctx, {sessionPath, sessionRef}, {type, payload, text}, {syncDelivery:true})
       │     = ctx.bus.request("session:send", {..., deliverAs:"steer"})   ← 真同步（流式 OD 注入）
       ├─ ② ctx.bus.request("session:send-custom", {customType, content, display:false, details, triggerTurn:true})
       │     = deliverCustomMessage（流式 followUp / 收束 triggerTurn，display:false 不刷屏）
       └─ ③ 防御：deferred:register + deferred:resolve（v2 allowlist 拒绝 → 日志）
  成功即 markDelivered + finalizeRegistry（task:* 被拒 → 内部降级日志）
```

- `sendSessionMessage(ctx, target, input, options)` 为本地内联 helper（镜像
  `@hana/plugin-runtime` 0.810.0 打包版实现：normalizeTarget + `bus.request("session:send", ...)`）；
  **内联原因**：v2 子进程（Node permission model，只读 installDir/dataDir，无 node_modules）
  解析不到 `@hana/plugin-runtime`；且 v2 bus 自动盖章 caller，`withContextMetadata` 的
  pluginId 注入由宿主代劳，无需 SDK。宿主无 `syncDelivery` 选项 → helper 将其映射为
  `deliverAs:"steer"`（真同步的真实开关 = verified caller + steer + 流式）。
- `{ type, payload }` 输入形态：session:send 契约要求 `text`（verified caller 缺 text 直接
  抛 `text or images is required`）→ helper 调用处补 `text: entry.content`（HBR markup），
  `type/payload` 透传（宿主忽略多余字段）。

### 4.2 index.js：v2 入口

- `apply(ctx)` 内：`getTaskManager(ctx.dataDir)` → `manager.restore()` → `globalThis.__dlBus = ctx.bus`
  → `registerHandler(bus, ...)`（v2 allowlist 无 `task:register-handler` → 内部 catch 降级）
  → `createDelivery(ctx, manager)`（替代 v1 pi 扩展订阅 mgr.onFinal/onStall）。
- 移除 v1 的 `pi.on('final'/'stall')` 注册方式（v2 无 pi 扩展通道）。

### 4.3 manifest / package.json

- manifest：`entry` 字段 + `manifestVersion: 2` + version `0.10.0`；不写 extensions/tools/dataDir/config。
- `capabilities: ["tools"]`（v2 脚手架约定；v1 的 `task.write/task.read` 在 v2 无对应枚举，且
  task:* 已被 allowlist 拒绝，写出来反而误导）。
- package.json `"type": "module"` 保留（v2 入口走 `import()`，ESM 必需）。

### 4.4 未迁移项（后续任务，本版本不碰）

1. **4 个下载工具**（`tools/download-file.js` 等）：v2 无静态 tools 目录，须改为
   `ctx.tools.register({ name, description, parameters, execute })`（单对象签名，`parameters`
   非 `inputSchema`）。未注册 → v2 下 agent 暂无下载工具。
2. **routes/download.js**：v2 用 `routes/` 目录自动装配或 `ctx.routes.register()`；v1 路由文件
   需按 v2 形态迁移（`getPluginRequestContext(c)` 取 bus）。
3. **contributes.cards**：v2 **仍支持**（`VBt`/`MBt` 实证，字段白名单 `Xae` 含
   id/title/description/route/embedUrl/cardForm/titlebar/…，**不含 v1 的 `type`/`icon`**），
   但卡片页面（app/card.js、manager.js）与 routes 未迁移前先不声明，避免卡片 404。
4. **permission model 约束**：v2 子进程只读 installDir/dataDir → 下载落盘到用户自定义目录、
   读会话 jsonl（tailSettled）会被 Node 权限模型拒绝；这些需要走 `ctx.resources` 或宿主侧
   处理（后续任务）。

---

## 5. 已知限制 / 待实测确认

1. **stock 宿主归属校验**：`session:send`/`send-custom` 往普通用户会话会被 `IAr` 拒
   （`does not belong to app`）。若当前运行宿主（bundle hash ≠ `.verified`，疑似魔改 build）
   已放开，则 v2 双通道成立——**需要用户实测确认**（本版本按放开假设实现，被拒有日志）。
2. **deferred:list-resolved**：host 无此接口（§3.2）→ abortAllstallKey 无法清已 resolve 的
   stallKey；v2 allowlist 连 `deferred:*` 都拒 → stock 宿主上 abortAllstallKey 只能记日志。
3. **deferred:* / task:* 在 v2 allowlist 外**：registry 双注册、deferred 防御通道在 stock 宿主
   上静默失效（各函数 try/catch + 日志，不阻断投递主通道）。
4. **tailSettled 在 v2 子进程恒 false**（读不到会话 jsonl）→ 一律先试 steer 通道；收束会话由
   send-custom triggerTurn / session:send 桌面消息兜底，语义与 v1 的"收束走异步"一致。
5. **v2 插件安装位置**：`<hanakoHome>/apps/hana-downloader/`（不是 `plugins/`），且需用户
   在 Settings → Apps 批准安装 + 授权（`app/session.start-turn` 等能力闸，`zf()` 校验）。
6. **未迁移项**（§4.4）会导致 v2 下暂无下载工具 / 卡片 / 路由——本版本仅交付投递层升级。

---

## 6. 校验结果

- `node --check index.js` ✅
- `node --check extensions/dl-nextturn.js` ✅
- `node --check app/manager.js` ✅
- manifest.json JSON 合法 ✅
- 模拟 v2 子进程 `resolvePluginApply` 加载入口：`typeof apply === "function"`，`apply(ctx)` 可运行 ✅
