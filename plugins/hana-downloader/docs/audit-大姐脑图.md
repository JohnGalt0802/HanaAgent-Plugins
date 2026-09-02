# 大姐内部脑图：download-progress 投递机制重估（2026-09-01 并行挖矿期间）

## 用户的核心质疑（必须正面回应）
- "从旧前端做到新前端，功能不断完善，不可能就这么失效了。"
- "现在的情况是，一直都有前端可见的同步投递，但是你说你不知道，说明你对这个机制已经没概念了。"
- 指示：并行派子代理挖现在插件结构和功能，写详细报告落盘。

## 我之前犯的框架错误（重估）
我把"同步投递"的唯一判据定为【agent 是否在下一条 jsonl 生成里复述了下载完成】。
但这个判据只覆盖了【面①：agent 消息线（jsonl custom_message / hana-background-result / steer）】。
而用户看到的【前端一直显示"大姐收到了来自 download 工具的结果"】属于【面②：前端视图线（卡片注解/渲染/message renderer）】。
**我把①线的判据拿去 judge②线的现象，得出"未感知→同步失败"——这是框架错位。**
插件真正的"同步投递"很可能就是②线（前端注解渲染），用户在 UI 层面看到"投递"即已完成，与 agent 是否在 jsonl 感知无关。

## 已确认的插件骨架（来自 index.js / dl-nextturn.js 头部注释与读到的代码）
- index.js（生命周期 onload）：
  - 恢复遗留任务状态（running→interrupted）
  - registerDeferred 占位注册（任务创建即占位，终态时 resolve 投递 hana-background-result 唤醒 agent）
  - manager.onStall 停滞提醒（动态注册 taskId:stall 占位并立即解析）
  - 遗留终态兜底（+6s 串行化，对账宿主 store，防跨重启双投）
  - onload 结尾 log: "download-progress v0.9.0 loaded (downloads → ...)"
- extensions/dl-nextturn.js（投递权威，最核心）：
  - pi.on 订阅工具/会话事件，captureSession 抓 currentSessionId/Path
  - ownThisSession(task)：判任务是否归属当前会话（比较 sessionPath 文件名）
  - steerViaBus 优先走 **session:send-custom + triggerTurn:true**（宿主原生同步，caller={pluginId}），失败降级 **pi.sendMessage({deliverAs:"steer"})**（仅 pi 有效时），再失败返回 unusable（走 deferred）
  - 未收束→steer / 已收束→deferred:resolve；_delivered + markDelivered 去重
  - pendingWake 唤醒重试队列（delivered确认、boot窗口hold、suppressed→re-arm）
  - dl-nextturn[from-scratch] loaded — 说明这是"从零重写"的一版

## 关键待办（等三份报告）
- [ ] 确认前端注解/渲染线（面②）到底走哪条链路：卡片注解？message renderer？show_card？emit？
- [ ] 确认面①与面②是否真正解耦：前端显示同步 ≠ agent 同轮 jsonl 感知
- [ ] 用"前端注解线"新视角重新判读 1473bae6 / b7a75f0e / 8217ae17 等实验
- [ ] 输出给用户的最终结论：插件从未失效，是我搭错了观察轴

## 决定性突破：宿主 deliveryIntent 机制（bundle 0.814）
- @589684：`const ky="hana-background-result", Cg="hana-deferred-result"`
- M0e(e) = `e?.meta?.deliveryIntent === "ui_only" || "notify_ui_only"`（宿主判断背景结果是否「只到 UI」）
- uGt(e)（@5540738）：是否触发 parent turn =
  - i8(e)（failed+notifyAgentOnFailure）→ true
  - triggerParentTurn===false 或 deliveryIntent==="notify_ui_only" → false
  - deliveryIntent==="trigger_parent_turn" → true
  - 否则 status==="resolved"
- @5542763 `_handleTask`：`if (M0e(r) && !i8(r)) { const n = await this._recordUiOnlyTask(t, r); return this._handleTask...}`
  → **`ui_only/notify_ui_only` 背景结果 → `_recordUiOnlyTask`（只记 UI 任务，不唤醒 agent turn）**
- @7296193：某个宿主 API 默认 `deliveryIntent:"ui_only", triggerParentTurn:!1, notifyAgentOnFailure:!0`

### 推断（待子代理交叉验证）
- **宿主有「UI-only 背景结果」通道**：deliveryIntent=ui_only/notify_ui_only → 只写前端 UI，不进 agent 输入
- 这解释了「前端可见同步投递 / agent 无感知」的宿主级机制——**用户看到的可能正是这一条线**
- 待确认：dl-nextturn 投递（session:send-custom / deferred:resolve）最终 meta.deliveryIntent 到底是什么（ui_only? trigger_parent_turn? 默认?）
- 1473bae6 那条 [4329] 曾进 input（非 ui_only），与前文「前端显示但 agent 无感知」需结合时间/通道区分

## 最新确认（session:send-custom 路径 → agent 必收到）
- host deliverCustomMessage @953808：streaming→sendCustomMessage({deliverAs:"followUp"})；非streaming→triggerTurn 默认true→主动发 turn 消费
- **该路径不设 deliveryIntent**，直接 sendCustomMessage 把 custom_message 写进会话 → agent 收到 + 前端显示
- deliveryIntent:ui_only（M0e/_recordUiOnlyTask）只作用于 **deferred 任务**路径，不是 session:send-custom 路径
- dl-nextturn 主通道 = session:send-custom + triggerTurn:true → agent 必收到（1473bae6 [4329] 正是如此，mine input）

## 需要向用户坦白的
- 之前判「没感知」是探针漏行（只看了 [4324]-[4327]，漏 [4329]），误判。
- 1473bae6 消息确实在 [4330] 生成前的 input 里（[4329]）→ 我【收到了】。
- 我 [4330] 生成的是「1473bae6:SESS-CUSTOM ERR…」讲日志，没复述「下载完成」——这是我处理/响应方式的问题，不代表没收到。

## 最终结论（三份报告落盘后统一，2026-09-01）
1. **插件未失效**，投递分两条独立线：
   - agent 消息线（dl-nextturn 唯一权威）：jsonl（session:send-custom+triggerTurn / deferred:resolve）
   - 前端视图线（宿主内置渲染管线）：hana-background-result+display:false entry → interlude块（与 agent 是否回复无关）
2. **判断同源与否，看通道**：
   - 未收束 + session:send-custom+triggerTurn：同一条 entry 同时写 jsonl(agent input) + streaming(前端 interlude) → 两条线都触发，解耦
   - 未收束 + pi.sendMessage(steer)：同上两条线都触发
   - 已收束 + deferred:resolve：桌面端 interlude 块【不出现】（MAt只处理sessionFiles / DAt只处理mediaKind，download任务都空）；只有 agent input 收到
3. **1473bae6 实锤**：未收束主通道 → [4329] custom_message 在 [4330] 前 = agent input 里有（我确实收到）+ 前端也显示（面②）→ **两条线都真**
4. **我之前误判的根**：把「agent 没复述下载完成」当「没收到」。实际收到≠复述（[4330]我讲了日志 = 我收到但选择处理方式）。「收到≠同轮≠复述」。
5. **视觉假象 source**：pi stale 是常态 + isStreaming 门锁死同步 → 实际多走异步 deferred → agent 下一回合才感知；但前端 600ms 轮询照常刷新状态字段（与异步/同步无关）→ 用户看到「同步投递」时 agent 可能已在下回合。

## 三份审计报告（已全部落盘）
- docs/audit-结构解剖.md（投递层唯一权威 dl-nextturn 全机制）
- docs/audit-前端投递链路.md（前端 interlude 块纯宿主渲染，插件前端零参与）
- docs/audit-投递机制全谱.md（3大类通道+1旁路；两条线独立性；v0.5→0.9演进）
