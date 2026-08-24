# Hana Download Manager

> 插件 ID：`download-progress` · 为 HanaAgent 提供**可观测下载**（observable download）能力：
> 下载任务实时可视化、进度状态可查询、中途可干预、终态双通道守望。
> 同时提供命令型下载（git clone / pnpm install）与跨会话下载管理器。

- 当前版本：v0.5.0
- 权限要求：full-access
- 运行环境：HanaAgent ≥ 0.158.0

---

## 一、背景与动机

日常任务中大量动作依赖下载，对象从几 KB 的配置文件到数百 MB 的安装包、模型文件不等。在引入本插件之前，Agent 的下载是典型的**无头下载**（headless download）：将 URL 交给 curl / Invoke-WebRequest 后干等进程结束。该模式存在四个结构性缺陷：

1. **进度不可知**：无法区分"进行中"与"已卡死"，二者在外部观察上完全一致。
2. **决策靠猜测**：缺乏真实进度，Agent 只能按文件大小与耗时估算，正确性全凭运气。
3. **小文件慢速 → 硬等**：几百 KB 的文件在网络不佳时也可能耗时数分钟，Agent 无反馈可用。
4. **大文件超时 → 杀进程重来**：超过等待阈值即杀进程，此时文件往往已部分落盘，只能加大阈值从头再来，浪费流量与时间。

结论：下载必须**有头**——进度可见、状态可查、中途可干预，Agent 才能基于事实做出正确决策。

## 二、核心架构

插件分为三层，各层职责单一、通过明确契约衔接：

```
┌─────────────────────────────────────────────────────┐
│  展示层                                              │
│  ├─ 进度卡片（聊天流内嵌 webview，600ms 轮询刷新）    │
│  └─ 跨会话管理器（/manager，集中管控全部会话的任务）   │
├─────────────────────────────────────────────────────┤
│  工具层（LLM 消费的四个工具）                         │
│  ├─ download-file     URL 下载（返回卡片 + taskId）   │
│  ├─ download-command  命令型下载（git clone/pnpm）    │
│  ├─ download-wait     回查守望（守望预算 + 异常检测，终态穿透）  │
│  └─ download-cancel   取消（来源签名 user/agent）     │
├─────────────────────────────────────────────────────┤
│  数据层（lib/dlcore.js 任务管理器）                    │
│  流式下载 · 测速 · 限速 · 停滞监测 · 终态事件 · 持久化  │
└─────────────────────────────────────────────────────┘
```

**层间契约**：

- 工具层 → 展示层：工具返回值携带 `details.card`（webview 卡片描述），宿主将其渲染在工具块正下方；卡片前端以 600ms 周期轮询 `/download/status` 刷新。
- 数据层 → 工具层：`onceFinal(taskId)` 提供终态一次性等待原语；`onFinal/onStall` 回调驱动通知分流。
- 工具层 → 宿主：`deferred:register/resolve` 总线通道承载跨回合投递（详见第四节）。

## 三、长任务守望机制（本插件的核心设计）

下载的生命周期常常跨越 Agent 的回合边界，因此守望机制按「Agent 是否在场」分为两条独立通道，切换点是 Agent 的显式决策而非隐式超时：

### 3.1 回合内：onceFinal 即时唤醒

Agent 调用 `download-wait` 后，等待循环与数据层的终态事件做竞速（`Promise.race`）。任何终态到达——包括用户在卡片上手动取消——wait **立即返回**，不等待轮询间隔，等效于剩余等待时间归零。

### 3.1 双通道完成通知（v0.5.2 定稿）

下载完成有两种通知通道，分工不替代：

- **同步通道（wait 守望）**：agent 回合内调 `download-wait` 守望，下载完成时在同一回合返回结果，
  agent 无需收束即可继续。守望期间 agent 可**并行执行其他工具**（并行语义）——下载后台推进，
  其他工具正常执行，wait 返回时拿全结果。
- **异步通道（deferred 投递）**：agent 收束后，下载完成由宿主投递 `hana-background-result` 自动唤醒
  发起会话。占位在 `download-file`/`download-command` 创建任务时**自动注册**，不依赖 Agent 任何操作。

选型原则：agent 回合内且仍有正事可做 → 用 wait（并行守望）；准备收束 → 直接收束，deferred 接管。
守望预算 90 秒：健康下载超过预算返回未完成快照，此时应收束（deferred 接管）；同一任务守望预算
到点后再次调用 wait 只返回快照（waitBudgetExhausted），机制上杜绝回查循环。

### 3.2 回合内：onceFinal 即时唤醒（同步通道）

Agent 调用 `download-wait` 后，等待循环与数据层的终态事件做竞速（`Promise.race`）。任何终态到达——包括用户在卡片上手动取消——wait **立即返回**，不等待轮询间隔，等效于剩余等待时间归零。

### 3.3 回合外：deferred 占位自动投递（异步通道）

1. `download-file` / `download-command` **创建任务时**自动注册 deferred 占位（携带发起会话的 sessionId/sessionPath）；
2. Agent 无论是否调用 wait、是否传任何参数，结束回合即可——下载终态到达时宿主自动投递 `hana-background-result` 唤醒发起会话；
3. Agent 已通过 wait 拿到结果时，投递结果携带 `consumedByWait: true` 供识别冗余，避免重复动作。

### 3.4 分流原则

| 场景 | 行为 |
|------|------|
| 创建任务 | 自动注册占位（不依赖 Agent） |
| 回合内完成/取消 | wait onceFinal 清零唤醒，同步返回结果 |
| 回合内并行守望 | wait 守望预算 90 秒；异常/预算到点返回，Agent 决策或收束 |
| 收束回合 | 占位已在创建时注册，下载完成自动投递唤醒（deferred 接管） |
| 同一任务守望预算已用尽 | 再调 wait 只返回快照（禁二次守望），收束等异步唤醒 |
| 宿主协议无「按任务取消占位」API | 终态必投递；Agent 已消费时投递冗余但无害（result 带 consumedByWait） |

### 3.4 取消来源溯源

每次取消均记录 `canceledBy` 来源：卡片按钮 = `user`，Agent 工具 = `agent`。该标注贯穿快照、wait 返回值与 deferred 投递消息；用户手动取消的通知附有「非故障，无需自动重试或换源」提示，防止 Agent 将人为干预误判为故障并自作主张重试。

## 四、守望循环（wait 同步通道，v0.5.2）

`download-wait` 守望模式下，脚本全程守望：**下载健康则持续等待直到终态，期间零打扰**；只有异常才提前返回交 Agent 决策。**守望期间 Agent 可并行执行其他工具**（并行语义），wait 返回时拿全结果。**Agent 手里没有 timeoutMs 旋钮——守望预算归脚本，决策归 Agent。**

- 终态（done / failed / canceled / interrupted）→ 正常返回；onceFinal 事件使取消与完成瞬间穿透等待循环；
- 停滞 → 后端 stalled 标记或本地 20s 无进展，立即返回；
- **双窗降速警报**：以 10s 为检测窗（首窗 5s 仅建立 EMA 基线，豁免慢启动），连续两个窗口均速跌破常态基线（EMA）的 30% → 携带诊断包（当前速度 / 基线 / 比值 / ETA）提前返回；
- **小文件慢速**（<100MB 但 ETA > 3 分钟）→ 立即返回（小文件正常应秒级完成）；
- **显著慢于历史**（当前速度 < 该域名历史均速 ×30% 且 ETA > 5 分钟）→ 立即返回（源站/网络异常信号）；
  以上两条与双窗降速相同，**首窗 5s 内豁免**（TCP 慢启动/代理建立/测速未稳，避免瞬时低速误报）；
  **主动限速（speedLimit>0）不检测慢速**——限速是 Agent 预期行为，速度慢不代表异常（v0.5.3）；
- **守望预算 90 秒**：健康下载超过预算返回未完成快照 + 收束指引（deferred 异步接管）；
  同一任务预算到点后再次调用 wait 只返回快照（waitBudgetExhausted），**机制上杜绝回查循环**；
- 速度估算优先使用同域名历史速度缓存（50 域名 × 5 样本，最新实测权重最高）；守望结束将实测速度写回缓存，形成自校正闭环。

## 五、功能清单

### 5.1 下载工具 download-file

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 下载地址（http/https） |
| `saveDir` | 否 | 保存目录绝对路径；留空用插件默认目录 |
| `fileName` | 否 | 自定义文件名；留空从 URL 推断 |
| `speedLimit` | 否 | 限速（字节/秒） |
| `startDelayMs` | 否 | 准备态延迟（毫秒），默认 0 |

返回文本自足：包含任务 ID 与免回查引导，Agent 单次调用即可获得全部后续所需信息。网络策略：代理优先（CONNECT 隧道，读系统代理），失败自动降级直连；支持标准 3xx 重定向与 npmmirror 式文本重定向。完整性红线：chunked（无 Content-Length）传输半途断连一律判 failed 并删除半成品——宁可重来不留坏文件。

### 5.2 命令型下载 download-command

`git-clone` 与 `pnpm-install` 白名单命令（不做 shell 拼接），解析输出流映射为阶段文案与百分比；Windows 下以 taskkill 杀进程树取消（pnpm 半成品 node_modules 保留，git clone 半成品目录删除）。

### 5.3 回查工具 download-wait

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskId` | 是 | 任务 ID |

行为由插件设置 `waitWatchMode` 决定：
- **关闭（默认）= 快照模式**：立即返回当前状态（进度/速度/ETA/终态详情 + 一次性慢速/停滞提示），不阻塞；
  Agent 收束后由 deferred 自动唤醒（返回文案引导）。
- **开启 = 守望模式**：守望最多 90 秒（同步通道），终态在本回合返回；守望期间可并行执行其他工具；
  异常（停滞/慢速/降速）立即返回带诊断包；预算到点返回未完成快照 + 收束指引；
  同一任务预算到点后再次调用只返回快照（waitBudgetExhausted，防回查循环）。
返回含 state / percent / speed / eta / error / filePath / stalled / slowAlert / slowSmall / histSlow / consumedByWait / deferredAutoRegistered（真实注册状态）。

### 5.4 取消工具 download-cancel

终止指定任务（来源签名为 agent），删除半成品文件。

### 5.5 跨会话管理器

`/manager` 页面集中展示所有会话的下载任务：列表、筛选（全部/在途/已完成/失败）、搜索、行内详情、打开文件/所在文件夹、默认下载目录设置。列表内部滚动，样式自包含浅/深双色板并跟随宿主主题广播切换。

## 六、设置项

| 设置 | 默认 | 说明 |
|------|------|------|
| `defaultSaveDir` | 空 | 默认保存目录，留空用插件数据目录 downloads/ |
| `stallTimeoutMs` | 30000 | 停滞判定阈值（毫秒） |
| `waitWatchMode` | false | wait 守望模式开关：关闭（默认）= wait 立即返回快照，Agent 收束后由 deferred 自动唤醒；开启 = wait 守望最多 90 秒（同步通道，守望期间可并行执行其他工具） |

## 七、项目结构

```
manifest.json             插件声明（full-access）
index.js                  生命周期：遗留任务恢复 + onFinal/onStall → deferred 投递 + onload 幂等兜底
lib/dlcore.js             任务管理器：流式下载/测速/限速/停滞监测/onceFinal/canceledBy/consumedByWait/持久化
lib/deferred.js           deferred 占位 helper（register/resolve + 全局 bus 兜底）
lib/progress-parsers.js   git/pnpm 输出解析（纯函数）
tools/download-file.js    URL 下载工具（创建即注册占位）
tools/download-command.js 命令型下载工具（创建即注册占位）
tools/download-wait.js    回查守望工具（守望预算 + 异常检测，self/timeoutMs 已退役）
tools/download-cancel.js  取消工具
routes/download.js        卡片页/管理器页/status/list/cancel/prepare/reveal/settings 路由
app/card.css|card.js      进度卡片前端（自包含色板、折叠交互、reportSize 报高）
app/manager.css|manager.js 跨会话管理器前端
extensions/enforce-download.js  下载约束注入扩展（预留，待宿主桥接 before_provider_request）
```

## 八、实现要点

- **准备态时序**：任务先以 pending 占位创建并返回卡片，延迟后自动启动——保证卡片从"准备中→0%→100%"全程可见，避免"卡片渲染时已跳 100%"
- **完整性红线**：仅当获得 Content-Length 且收满才判 done；chunked 断连判 failed 删半成品。此判定不可放宽——残缺文件误判完成比删文件更糟
- **停滞监测**：每 5s 巡检，超阈值标记 stalled 并触发独立投递（不自动取消，决策权在 Agent）；进度恢复自动解除
- **重启恢复**：任务持久化于 tasks.json（保留最近 100 条终态）；应用重启后遗留 running 统一标记 interrupted，不留僵尸任务
- **测速**：700ms 采样 + 滑动窗口平均；卡片 600ms 轮询刷新
- **鉴权**：卡片 iframe 自动携带 URL token（本地连接）或 X-Hana-Plugin-Surface-Session 头（远程连接）
- **防缓存**：卡片与管理器路由 `Cache-Control: no-store`
- **卡片高度限界**：两行布局高度钉死（信息行 24px / 进度行 14px）+ 锁定行高因子 + 四周 overflow 截断，杜绝渲染中间态瞬时拱高导致的滚动条跳动
- **explorer 安全**：打开文件/文件夹走服务端路由（cmd /c + 引号 + `^` 转义特殊字符），路径白名单校验（仅任务记录内的文件/目录），消除命令注入面

## 九、宿主适配补丁

聊天流内嵌插件卡片与主题联动依赖对宿主 renderer 的手工补丁（Hana 升级会覆盖，需重打）：

| 补丁 | 作用 |
|------|------|
| SendButton Fn 内嵌 iframe | 聊天流内 plugin_card 渲染真实内容而非占位壳 |
| theme.js 主题广播 | 主题切换向全部插件 iframe 广播，页面实时换肤 |
| 内嵌框高度自适应（ref 隔离 + 去抖） | 每个卡片仅响应自身 iframe 的高度消息（ref 匹配，杜绝多卡片高度联动）；90ms 去抖过滤瞬时异常报高 |

自动化维护工具：`D:\HanakoWorks\_tools\hana-host-patches\apply-patches.mjs`（支持 --check 与幂等重打），台账见同目录 PATCHES.md。

## 十、验证记录（摘要）

- 四并发混合负载（URL ×3 含 chunked/限速 + git clone + pnpm install）互不干扰，字节零缺漏
- 双通道守望四象限实证：回合内取消（onceFinal 即时弹起，6s 场景实测）、回合内完成（静默收束）、离场后完成（deferred 投递含 filePath）、离场后取消（投递含 canceledBy=user 与免重试提示）
- 解析器单测 13/13；pnpm/git 真实全链路 done
- 404/chunked/限速/代理降级/文本重定向均有专项用例

## 十一、版本里程碑

| 版本 | 要点 |
|------|------|
| v1.0–1.3 | 可观测下载基础：卡片、wait 双模式、卡死预警、历史速度缓存 |
| v1.4–1.5 | 文件夹按钮、停滞检测、cancel 工具、chunked 完成态修复 |
| v1.6.x | 命令型下载、停滞强化、实时注入、wait 节拍器（动态观察窗）、notifyWhenDone deferred 通知 |
| v0.2.x | 跨会话管理器、主题跟随重建、高度内容驱动、服务端 explorer、安全加固 |
| v0.3.x | canceledBy 来源标注、onceFinal 即时唤醒、卡片定宽、青夜字色、返回文本自足、双通道守望定形 |
| v0.4.0 | wait 守望循环重构：健康续窗至终态、双窗降速警报（10s 检测窗/EMA 基线/首窗 5s 豁免）、suggestNextWaitMs 退役、loopback 代理豁免 |
| v0.5.0 | **deferred 占位自动注册**（创建时 await 注册，终态必投递，onload 幂等兜底，Agent 零操作）；**timeoutMs/mode 参数移除**（self 退役，等待预算归脚本）；**异常检测新增**：小文件慢速（<100MB & ETA>3min）、显著慢于历史（<历史 30% & ETA>5min），首窗 5s 豁免；wait 消费标记 consumedByWait；review 修正：register 竞态防护、deferredAutoRegistered 报真实值、onceFinal 可取消防 waiter 泄漏、restore 读回 sessionId、git-clone 加 --progress、停滞占位 key 唯一化；修 download-file 缺失 fs import |
| v0.5.2 | **双通道定稿**：wait=同步通道（守望，并行语义，预算 90 秒），deferred=异步通道（创建时自动注册，收束后投递唤醒）；**防回查循环**：守望预算到点后禁二次守望（waitBudgetExhausted），未完成时收束指引唯一方向（不再提供继续守望）；修复 wait 守望模式变量作用域崩溃（stalled is not defined）；修复 dlcore snapshot/_persist 漏加 deferredRegistered 导致的误报 |
| v0.5.3 | 主动限速（speedLimit>0）排除慢速/历史对比检测：限速是 Agent 预期行为，不再误报「小文件慢速异常」（实测复现并修复） |
| v0.5.4 | **守望开关**：waitWatchMode 配置（默认关闭）——关闭=wait 立即快照（默认流程：创建→快照→收束→deferred 自动唤醒），开启=守望 90 秒（同步通道）；快照模式带一次性慢速/停滞提示；自然派活实测：快照模式收束指引有效（Agent 自然收束等唤醒）、慢速提示引导收束、并行语义成立、主会话收束后 deferred 唤醒链路验证通过 |

---

*作者：John Galt · dahua · hanako*
