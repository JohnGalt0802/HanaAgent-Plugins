# 下载进度插件 · 项目需求文档（PROJECT REQUIREMENTS）

> 本文档是下载进度插件的**开发唯一依据**。后续所有技术判断、改动、测试，都按本文档执行，不再向用户逐项确认"该怎么做"。
> 版本：2026-08-31（重组为 host-native-first 投递层，dev 工作目录迁至 `D:\HanakoWorks\download-progress`）
> 配套：`docs/six-quadrant-test.md`（六象限测试标准，随投递层改动全量回归）

---

## 1. 项目定位

Hana 下载进度插件：跨会话统一管理 agent 发起的下载任务——实时可视化、进度可查、中途可干预、终态可靠通知。

- 版本基线：当前 v0.9.x（在 0.9.0 基础上收敛投递层）
- host 版本：0.810.0
- 工作目录：`D:\HanakoWorks\download-progress`（dev 槽 sourcePath）

## 2. 核心需求（投递语义，最高优先）

**下载终态（完成/取消/卡滞）必须可靠、无重复地送达会话。**

投递语义（同回合及时感知是一切的根基）：

| 场景 | 投递通道 | 语义 |
|---|---|---|
| **未收束会话（unsettled）**｜download 完成 | **同回合同步投递** | agent 在**当前未收束对话**的下一步感知到完成，不延迟到收束后 |
| **未收束会話**｜agent 取消 | **静默** | `canceledBy=agent`：download-cancel 的同步返回值就是结果，不再唤醒（避免回音壁） |
| **已收束会话（settled）**｜download 完成 | **异步投递** | `deferred:resolve` → 宿主投递 `<hana-background-result>` 唤醒收束会话 |
| **收束后**｜非 agent 取消 | **异步单投** | `canceledBy=user`（卡片/stop_task）→ 异步通知，附取消来源语义 |

**铁律（不可违反）**：
1. **同回合同步投递到位后，不得再有任何异步通知**（严禁"回合内同步 + 收束后异步"双投）。
2. **每个任务整个生命周期只允许收到一条回执**（同步或异步，取决于 settle 状态）。严禁双投。
3. **不重复通知 > 不漏一条**：评估修复方向时用"会不会批量放大成几十条"做标尺；边缘偶发一条（无害）可接受，批量重复是灾难。

## 3. Host 能力边界（已实测确认，不可再反复）

### 3.1 Host 原生**有**的能力
| 能力 | 入口 |
|---|---|
| 占位生命周期 | `deferred:register` / `query` / `list-pending` / `retry` / `abort` |
| **异步投递** | `deferred:resolve`（host store 自动 `markDelivered` → delivered=true → `hGt(!delivered)` 防重投） |
| 任务实例注册 | `task:register` / `cancel` / `complete` / `fail` / `query` / `list` |
| **同回合同步注入** | 插件 API **`pi.sendMessage(msg, {deliverAs:"steer"})`**，host `JIr={"next-step":"steer","next-turn":"followUp"}` 映射 |
| 同回合 followUp | `pi.sendMessage(msg, {deliverAs:"followUp"})` |
| session 级投递 | `session:send` / `session:send-custom`（`triggerTurn`/`isStreaming` 判定） |

### 3.2 Host **没有**（插件自研/补丁路径，宿主当前未注册）
| 名称 | 实测状态 |
|---|---|
| `deferred:steer` | **不存在**（bundle count=0，报 "No handler registered for deferred:steer"） |
| `deferred:suppress` | **补丁已回滚**（踩坑记录 L436；reason 泄漏 bug，宿主无此路由） |
| `steeringQueue` | **不存在**（bundle count=0，注释里的假设无效） |

### 3.3 Host 同步投递的**锁死点**
host 的 `steer`/`followUp`/`deliverAs` 同步分支**前提是 `isStreaming === true`**（@7551092 分支；`isSessionStreaming` 判定）。而 **download 完成时 agent 已结束生成 → `isStreaming === false`** → 走 `triggerTurn`（异步）。

**直接推论**：
- Host 原生同步口子 = `pi.sendMessage(msg, {deliverAs:"steer"})`（走 `target:"next-step"`）。
- `deferred:steer` 补丁那条**是死路**（宿主无路由），不得依赖。
- `deferred:suppress` 补丁也**已回滚**（宿主无路由），代码里的 `bus.request("deferred:suppress")` 调用是**无害死代码**（`.catch` 吞掉），但不应作为依赖。

## 4. 投递层实现原则（host-native-first）

**能用 host 原生就用 host 原生；原生不行的用插件；原生死路的不依赖。**

- **同回合同步**：用 `pi.sendMessage(msg, {deliverAs:"steer"})`（host 原生）。
- **异步投递**：用 `deferred:resolve`（host 原生）。
- **不依赖**：`deferred:steer`、`deferred:suppress`、`steeringQueue`（都是补丁/已回滚/不存在）。

## 5. 六象限测试标准

详见 `docs/six-quadrant-test.md`。投递层任何改动（`extensions/dl-nextturn.js`、`lib/deferred.js`）后**必须全量回归**，通过 = 每象限**仅一条回执** + 通道正确 + store 状态正确。

## 6. 开发纪律

1. **不重复 > 不漏**（见 §2 铁律）。
2. **修 bug / 改机制前先问**"会不会把 A 种小病放大成 B 种大灾"。
3. **宿主能力必须实测验证**，不能只信静态推导（`bus.subscribe` 能注册 ≠ 会触发；方法名存在于 bundle ≠ 暴露给插件）。凡是接入宿主内部能力，先做最小探针实测。
4. **为方向无害的冗余动宿主 core 一致性 = 不值**（收益低、风险高）。
5. **根因未明前只增不改不删**；不可逆清理要留档。
6. **结算一个任务：单投 + store 正确 + 无重复回执** 才算通过。
7. **改动范围**：`extensions/`、`lib/` 走插件加载路径可直接重载；`tools/*.js` 需重启 host 进程。改完必须 `node --check` 语法校验 + 热重载。

## 7. 已知限制（接受，不再深挖）

- **host 不暴露 turn/回合级状态给插件**（`bus.subscribe` 收不到 turn 事件；无 `session:is-streaming` 等查询）。插件判定收束用 `tailSettled(sessionPath)` 读 jsonl 尾部（真实、可靠）。
- `isStreaming` 是 host 内核状态，插件拿不到；plugin 只能近似判断（`tailSettled`）。
- `pi.sendMessage` 间歇性报 "Extension runtime not initialized"（host `createExtensionRuntime()` 把 action 方法做成 throwing stub，`bindCore()` 后可用；特定生命周期窗口报错）。正常安装时段能成功（8-30 `STEER(queue) sent` 实证），dev 重载报错偏多。属 host 时序，非插件逻辑错误；不再深挖，作为已知限制。

## 8. 目录约定

```
D:\HanakoWorks\download-progress     ← dev 源码（改这里）
  ├── index.js                       生命周期
  ├── extensions/dl-nextturn.js      投递层唯一权威（dual-channel 分界）
  ├── lib/deferred.js                占位注册/resolve
  ├── lib/dlcore.js                  任务管理器
  ├── routes/download.js             取消/清空/全部取消路由
  ├── app/  card.js/card.css/manager.js/manager.css
  ├── tools/  download-file/cancel/wait/command
  ├── docs/six-quadrant-test.md      六象限测试标准
  └── patch/  patch-theme-0.680.21.js (主题联动补丁，与投递无关)
```

配套（不改源码）：
- `C:\Users\John Galt\.hanako\plugins-dev\download-progress`（dev 运行拷贝，reload 时从源码同步）
- `C:\Users\John Galt\.hanako\plugin-data\download-progress`（运行数据：downloads/、tasks.json、config.json）
- `C:\Users\John Galt\.hanako\.ephemeral\deferred-tasks.json`（宿主 deferred store，验证投递状态）

## 9. 工作方式（对用户）

- 用户**定方向和目标**；我**按本文档 + 六象限标准执行技术实现与判断**，不再逐项问"怎么做"。
- 遇到本文档未覆盖的**真歧义**（且无法从文档/实测推导），才向用户确认；能推导的不问。
- 投递层改动后**全量回归六象限**，以实测结果说话，不臆测。

## 10. 下一步（本轮遗留）

1. 投递层按 §4 host-native-first 原则收敛：同回合用 `pi.sendMessage({deliverAs:"steer"})`，异步用 `deferred:resolve`，清除对 `deferred:steer`/`deferred:suppress`/`steeringQueue` 的依赖。
2. 收敛后跑**标准六象限**（用稳定源，如 jsDelivr `cdn.jsdelivr.net`），确认每象限单投 + 通道正确。
3. 版本 bump 到 v0.9.2，打包。
