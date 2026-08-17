# 下载进度条插件（download-progress）

Agent 执行下载任务时，在操作块下方显示**实时进度条卡片**：

- 百分比进度条
- 文件总大小 / 已完成量
- 实时下载速度（滑动窗口测速）
- 剩余时间估算（ETA）
- 取消下载按钮
- 完成后：打开文件 / 打开所在文件夹 / 复制路径
- 左侧折叠按钮：`❯` 展开/收起本条详情，`□` 展开/收起所有下载卡片
- 停滞检测：连接无新数据超过阈值（默认 30s，可配置 stallTimeoutMs）判定停滞，卡片标记 stalled 徽标并**实时提醒 Agent 决策**（不自动取消）
- 失败实时提醒：下载失败时尝试立即注入会话（session:send，Agent 空闲即达；回合活跃则放弃不排队），Agent 自主决策重试/换源

---

## 为什么做这个插件（背景与动机）

日常任务里大量动作需要**下载文件**，而下载对象的大小千差万别：
从几 KB 的配置文件，到几十上百 MB 的安装包、数据集、模型文件。

在引入本插件之前，Agent 下载文件是典型的**无头下载**（headless / 盲下载）：
把 URL 丢给 curl / Invoke-WebRequest 之类的命令，然后干等进程结束。

这种模式有四个致命问题：

1. **完全无法判断下载走到哪一步**。不知道是刚开始、进行中、还是已经卡死。
   一个"正在下载"的进程和一个"卡住不动"的进程，从外面看起来完全一样。

2. **Agent 只能靠猜**。没有进度信息，Agent 只能根据文件大小和已耗时去估算，
   猜得对不对全凭运气。

3. **小文件下载慢 → Agent 硬等**。有些文件明明很小（几百 KB），
   但网络慢的时候下载要几分钟，Agent 没有反馈，只能傻等，
   甚至误判为卡死。

4. **大文件超过阈值 → Agent 杀进程，重来一遍，还加阈值**。
   这是最折腾的场景：文件大、耗时长，超过了 Agent 设定的等待阈值，
   Agent 就把进程杀掉，结果发现**文件已经下载了一部分**，
   只能重新下载，把时间阈值调大再来一次。反反复复，效率极低，
   还白白浪费了已经下载的流量和时间。

**结论**：下载必须**有头**——进度实时可见、状态随时可查、中途可干预，
Agent 才能根据真实进度做出正确决策（继续等、限速、取消、重试），
而不是在黑箱里盲猜。

## 解决方案：把下载包装成"有头下载"工具

本插件把下载动作包装为一个标准工具 `download-file`，核心思路：

1. **强制走工具**：全局规则约定所有 Agent 下载一律调用 `download-file`
   （替代 curl / Invoke-WebRequest 裸下载），从机制上杜绝盲下载。
2. **进度实时可视化**：工具启动后台流式下载，立即在聊天流操作块下方
   渲染进度卡片（百分比 / 大小 / 速度 / ETA），每 600ms 刷新一次，
   下载到哪一步一目了然，是否卡死一眼可判。
3. **中途可干预**：随时取消；下载完成直接打开文件或复制路径。
4. **不再折腾阈值**：Agent 看到真实进度后，可以按需限速（speedLimit）、
   判断剩余时间、决定等待还是放弃，不再"杀掉重来加阈值"。
5. **进程重启不丢状态**：任务状态持久化，应用重启后遗留任务标记为
   中断（interrupted），不留下僵尸进程和半成品误导。

> 注：英文里 headless 指"无界面/无头"，相对地"有头"即 headed / 带界面的下载；
> 在 Agent 场景下更准确的说法是**可观测下载**（observable download）或
> **带状态反馈的下载**（progress-aware download）。

---

## 使用方式

Agent 需要下载文件时，优先调用 `download-file` 工具（而不是 `exec_command` 里的 curl / Invoke-WebRequest），
工具启动后台流式下载并立即返回进度卡片，卡片渲染在工具操作块正下方，实时刷新。

参数：

| 参数 | 必填 | 说明 |
|------|------|------|
| `url` | 是 | 下载地址（http/https） |
| `saveDir` | 否 | 保存目录绝对路径；留空用插件默认目录 |
| `fileName` | 否 | 自定义文件名；留空从 URL 推断 |
| `speedLimit` | 否 | 限速（字节/秒），大文件避免占满带宽 |
| `startDelayMs` | 否 | 准备态延迟（毫秒），默认 0 立即开始；卡片渲染晚于下载也无妨，完成后照常显示 100% |
| `stallTimeoutMs` | 否 | 停滞判定阈值（毫秒，默认 30000），连接无新数据超此时长标记停滞并后台通知 |

配套工具 `download-cancel`：

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskId` | 是 | download-file 返回的任务 ID |

取消后任务状态变为 canceled、半成品文件删除。典型场景：收到停滞通知后决策取消、速度长期不达标、换源重下。

## 配套工具 download-wait（Agent 回查进度）

`download-file` 是立即返回的（卡片先渲染、下载在后台跑），Agent 需要主动回查进度：

| 参数 | 必填 | 说明 |
|------|------|------|
| `taskId` | 是 | download-file 返回的任务 ID |
| `mode` | 否 | auto=按文件大小自动估算等待阈值（默认）；manual=用 timeoutMs 手动阈值 |
| `timeoutMs` | 否 | 手动等待毫秒数（manual 模式使用；auto 模式下作为估算阈值的上限） |

返回完整状态快照（state / total / received / percent / speed / eta / error / filePath / stalled / thresholdUsed），
Agent 据此决策：进度/速度正常→继续等；`stalled=true`（进度 20s 无进展，疑似卡死）或速度归零→取消/换源；
ETA 超预期→换源；完成→直接使用文件；失败→按错误决定重试/换源。

**auto 模式（默认）**：工具内部先拿文件总大小，按分档本地估算等待阈值（≤10MB→60s、≤100MB→300s、
≤500MB→15min、≤2GB→30min、更大→60min），Agent 只需 `download-wait(taskId)` 一步，无需自己算。
**manual 模式**：用 `timeoutMs`（未传则用插件设置 `manualTimeoutMs`），适合有明确预期的场景。

**推荐流程**：
1. `download-file` 启动下载
2. `download-wait(taskId)`（auto 自动估算阈值），到点/完成后按快照决策
3. **未完成且决定继续 → 立即再调 download-wait 跟进**（续接铁律），直到 done/failed/放弃；无排队通知，实时状态一律以 wait 回查为准

**通知策略（无排队通知，全实时）**：
- `download-wait` 主动轮询是唯一实时主路径（秒级，失败/完成/停滞立即返回）
- 失败/停滞的被动提醒：尝试 `session:send` 立即注入（Agent 空闲即达）；宿主拒绝（session_busy，回合活跃）则放弃，不排队
- 成功不通知（wait 查即可）；无 deferred 回合边界排队通知

## 配套工具 download-command（命令型下载：git clone / pnpm install）

Agent 需要克隆仓库或安装依赖（体感上是“下载行为”）时，可调用 `download-command`，
在聊天流显示实时进度卡片，后台 spawn 命令并解析输出刷新进度。命令白名单，不做 shell 拼接。

| 参数 | 必填 | 说明 |
|------|------|------|
| `kind` | 是 | `git-clone` 或 `pnpm-install` |
| `repo` | git-clone 必填 | 仓库地址（http/https/git@/本地路径） |
| `targetDir` | 否 | 目标目录绝对路径（git-clone 专用，默认取仓库名；已存在则报错不覆盖） |
| `workdir` | install 必填 | 执行工作目录（git-clone 可选，默认当前目录） |
| `label` | 否 | 卡片显示名 |

进度解析：git clone 的 stderr（Enumerating/Receiving objects/Resolving deltas/Updating files）与
pnpm install 的 stdout（Packages:/Progress:/postinstall/Done in）→ 阶段（stage）+ 进度百分比。
卡片 sizeText 按单位显示（对象/文件/包），运行中 meta 显示阶段文案，完成态显示「打开文件夹 + 复制路径」。
取消：Windows 用 taskkill /pid X /T /F 杀进程树（pnpm 半成品 node_modules 保留、git clone 半成品目录删）。

## 设置

插件设置：
- `defaultSaveDir`：默认保存目录（绝对路径），留空则保存到 `插件数据目录/downloads/`
- `waitMode`：download-wait 默认回查模式（auto / manual）
- `manualTimeoutMs`：manual 模式默认阈值（毫秒）

## 结构

```
manifest.json         插件声明（full-access）
index.js              onload：恢复遗留任务 + 注册终态回调（deferred 通知 Agent）
lib/dlcore.js         下载任务管理器（流式下载 / 测速 / 取消 / 限速 / 持久化 / 终态回调 / 历史速度缓存）
tools/download-file.js 下载工具（返回进度卡片，注册 deferred 占位，失败时后端提醒）
tools/download-command.js 命令型下载工具（git clone / pnpm install，返回进度卡片，解析输出实时刷新）
tools/download-wait.js 等待/回查工具（轮询状态，返回进度快照供 Agent 决策）
tools/download-cancel.js 取消工具（Agent 侧主动终止任务，删除半成品）
routes/download.js    /card/download 卡片页 + /download/status + /download/cancel + /download/prepare
app/card.css          进度条卡片样式（两行紧凑布局，跟随 Hana 深浅主题）
app/card.js           卡片前端（轮询进度，折叠交互，mini host SDK 调 resource.open / clipboard）
```

## 实现要点

- 进度卡片 = 工具返回值 `details.card`（webview/iframe 类型），宿主自动渲染在工具块下方
- 下载在插件进程后台流式执行（Node 原生 fetch，不依赖第三方库）
- 卡片每 600ms 轮询 `/download/status` 刷新进度；测速用 700ms 采样 + 3.5s 滑动窗口
- 支持 `speedLimit` 限速参数（字节/秒），大文件可避免占满带宽
- 无 Content-Length（chunked）时进度条切换为不定态动画，仍显示已完成量；
  v1.5.2 起：下载完成后 total 以实际接收字节兑底（total=received），完成态强制满格 100%
  （修复“完成但进度条半截”：终态脱离不确定态 + 数据层兑底 + restore 历史数据兑底）
- 准备态机制（prepare + startDelayMs）：工具先返回卡片（渲染"准备中"），
  延迟后自动启动下载，解决"卡片渲染时下载已完成（跳 100%）"的时序问题
- 两行紧凑布局：第一行（图标 + 文件名 + 状态徽标 + 速度/剩余 + 按钮），
  第二行（进度条 + 百分比 + 已下载/总大小），高度自适应贴合内容
- 折叠交互：`❯` 旋转 90° 展开本条详情（文件/路径/大小/任务/状态），
  `□` 旋转 45° 变菱形展开所有卡片，跨卡片联动用 BroadcastChannel（同源 iframe 通信）
- 状态持久化到 `dataDir/tasks.json`，应用重启后遗留任务标记 interrupted
- 下载完成/失败/取消会删除半成品文件（完成后保留）
- 数据完整但流收尾报错（undici 在连接关闭边界的 terminated）时按成功处理，确保文件落盘
- 完成通知：任务终态通过 deferred:resolve / deferred:fail 记录状态（成功 notify_ui_only 不打扰；失败 notifyAgentOnFailure 唤醒 Agent 处理）
- 停滞通知：stalled 时注册独立占位（taskId:stall）+ resolve（trigger_parent_turn 唤醒 Agent，含进度与决策提示）
- 样式遵循 Hana 设计语言：消费宿主注入的主题变量（--text/--accent/--green/--danger 等），暗色 UI 亮字、明亮 UI 暗字自动切换；正文 14px，小字 12px，百分比 14px
- 卡片 iframe 内轮询自动携带 URL 里的 `token`（本地连接）与 `X-Hana-Plugin-Surface-Session`（远程连接），避免 403

## 测试记录（2026-08-10）

- 40MB 本地下载：478ms 完成，进度 0→100%，文件大小一致
- 限速 2MB/s：进度 28.9%→51.1% 实时推进，速度采样 2.0~2.4MB/s 吻合
- 取消：state=canceled，半成品文件删除
- 404：state=failed，错误 "HTTP 404 File not found"
- 卡片 UI：运行中（30% + ETA + 取消按钮）/ 完成（100% + 打开/复制）均渲染正确
- 真实网络：three.js（9MB）、electron（110MB）、VS Code（227MB）下载全程进度正常
- 新会话实测 details.card 链路：卡片在工具块正下方、准备中 → 0% → 100%、高度贴合
- v1.1.0 折叠功能：❯ 展开/收起本条（箭头旋转 90°、详情区显示文件/路径/大小/任务）、
  □ 旋转 45° 变菱形并展开所有卡片（BroadcastChannel 跨 iframe 联动实测生效）
- v1.2.0：download-wait 回查工具（实测 15s 返回 33.9% + 930KB/s + ETA 29s，Agent 决策信息完备）；
  deferred 完成通知（register/resolve 实测 ok，终态回调触发）；修复限速下载在连接关闭边界的
  undici terminated 误判（数据完整按成功处理）；修复 lib 模块缓存导致 onload 拿旧实例的问题
  （改名 + globalThis 版本化单例）；限速下载回归：4MB/40MB 均 done 且文件字节完整
- v1.3.0：wait 双模式（auto 按大小分档自动估算阈值，本地计算不费模型算力 / manual 手动阈值，
  可在插件设置中切换默认）；卡死预警（进度 20s 无进展提前返回 stalled=true，不等阈值到点）；
  tasks.json 持久化只保留最近 100 条终态；实测：auto 模式 4MB 自动算 60s 阈值 7s 完成返回 done，
  manual 模式 5s 阈值到点返回 92.2% + ETA 1s
- v1.4.0：auto 阈值参考同域名历史下载速度缓存（实测 4MB 用 480KB/s 历史速度估算出 15s 阈值）；
  卡片折叠详情区新增"预计 HH:MM 完成"；deferred 通知改 notify_ui_only（记录不唤醒，保持轻量）；
  修复持久化清理把保留任务误删的 bug；模块缓存最终解法（lib 改名 dlcore.js + globalThis 版本化）
- v1.5.0：停滞检测（30s 无新数据标记 stalled + download-stall 后台通知 Agent 决策，不自动取消；四并发实测互不干扰，停滞通知送达真实会话）
- v1.5.1：download-cancel 工具（Agent 侧取消，实测 canceled + 半成品删除）；失败后端提醒（notifyAgentOnFailure 唤醒 Agent，404 实测通知送达含原因）；停滞触发即刷盘；wait 透出 stalledAt
- v1.5.2：修复 chunked（无 Content-Length）下载“完成但进度条半截”渲染 bug。根因：GitHub codeload 动态打包 zip 返回 chunked 响应 → total=null → percent=null → 终态未脱离不确定态（CSS .dl-bar.indet 固定 40% 宽条纹）。修复：渲染层终态（done/failed/canceled/interrupted）强制脱离 indet、done 满条 100% + 数据层正常收尾路径 total=received 兑底 + restore 历史 done 任务兑底 + wait 卡死检测覆盖 chunked。红线：catch 分支 complete 判定勿放宽（残缺文件误判完成比删文件更糟）。验证：harness 5/5 + 四并发（3 带 CL + 1 chunked）全绿、字节零缺漏
- v1.5.3：完成态新增“文件夹”按钮（resource.open + mode:reveal → showInFinder，打开所在文件夹并选中文件）；“打开”按钮改为系统默认程序打开文件（原为 reveal 定位，与新按钮语义重复）
- v1.6.0：命令型下载任务（git clone / pnpm install）。新建 `lib/progress-parsers.js`（纯函数解析器，git 无状态 / pnpm 状态化防累加）、`tools/download-command.js`（白名单命令工具）；`lib/dlcore.js` MGR_VER 12、task 增 kind/cmd/unit/stage/child 字段、停滞监视器提取 `_startStallMonitor/_stopStallMonitor`、`_runCommand` 用 spawn 跑命令（数组传参、缓冲截断 4KB）、命令解析 `resolveCommandBin`（Windows 兼容：npm 全局装的 pnpm 是 .cmd shim，裸 spawn shell:false 执行不了（EINVAL），解析 `pnpm/bin/pnpm.mjs|cjs` 用 node 运行，保持无 shell 无注入面）、cancel 加 Windows taskkill /T /F 杀进程树、snapshot/_persist/restore 同步字段（restore 时 command 中断按 cmd.type 分支删/留半成品）；卡片按 unit 显示大小、运行中 meta 追加阶段文案、命令型完成态只给 打开文件夹+复制路径。验证：解析器单测 13/13、pnpm/git 真实全链路 done、四并发混合（2 pnpm + 1 git + 1 url chunked）4/4 done 互不干扰、进度可见性（git checkout 28%→100% 连续推进 / pnpm 阶段映射）、宿主重启后新会话工具注册可见、UI 卡片经用户确认进度条与完成态按钮正常。
