# Card `emit` 能力指南（card-emit-guide）

> 宿主 0.810.0 内置卡片 API 规范。供卡片 UI 交互驱动 agent 用。
> 注意：**`emit` 不是投递层通道**——它是「卡片里用户动作 → 上报给会话」；投递层走 `deferred:resolve`（异步）/ `pi.sendMessage({deliverAs:"steer"})`（同回合）。

---

## 1. `window.card` 完整方法面

```js
await window.card.capabilities()                     // 卡片跑在哪个 surface、支持哪些能力
await window.card.state.get("memo")                  // 读卡片自身实例状态
await window.card.state.set("memo", "hello")         // 写实例状态
await window.card.invoke("binding-id", { ...input }) // 触发 manifest 声明的 binding
await window.card.emit("event-name", { payload })    // 上报事件 → 落会话 → 唤醒 agent
await window.card.track("event-name", { payload })   // 安静记录 → 活动日志 → 不唤醒
await window.card.data.get()                          // 读 agent 下发显示的数据
window.card.data.onChange(cb)                         // 订阅 agent 写数据
```

## 2. `emit` 语义

> "When a card needs the Agent to respond to a user action, call `window.card.emit(name, payload?, to?)`. The event lands in a conversation as a message and wakes the Agent."

**用 emit 的场景**：用户在卡片上做了一个有意义的步骤（动了棋子、提交表单、完成一步）→ 需要 agent 立刻响应。

**`ok:true` 的含义**：宿主**接受了投递**，**不是 agent 已回答**。别拿它当"已响应"。

## 3. `emit` vs `track`

| | `emit` | `track` |
|---|---|---|
| 是否唤醒 agent | 是，落会话、唤醒 | 否，写活动日志 |
| 用途 | agent 必须立刻响应 | 只留记录，稍后 `read_card_activity` 读 |
| 节流 | **20 条/分钟** | **120 条/分钟** |
| 出现位置 | 出现在对话里 | 不进对话 |

> 原文："Use emit when the Agent must react immediately. Use track when you only need a record to consult later."

## 4. 调用约束（能力边界）

1. **只对卡片 slot 生效**：`card.emit` 是卡片 webview 内的 `window.card`，**不是插件运行时 `pi`**（`pi.emit` 不存在）。插件侧 `pi` 没有 emit。
2. **`name` 命名**：`^[a-z0-9][a-z0-9._-]{0,63}$`（小写字母数字开头，≤64 字符）。
3. **`payload` 上限**：JSON 序列化后 ≤ 8KB（8192 UTF-8 bytes）。
4. **节流**：emit 20/分钟，track 120/分钟。
5. **`to` 参数**：只在用户明确说"发到某处"才传。默认路由：
   - 卡片在**对话里**（无 to）→ 落到**嵌入它的会话**。
   - 卡片 **pinned/弹窗**（无 to）→ 仅当用户触发 emit 且聊天界面可见时，到**当前聚焦会话**。
   - **pinned/弹窗卡片自动 emit 且无 to → 失败**（`CARD_HOST_EMIT_NO_ROUTE`，无对话伙伴）。
6. **先 `capabilities()` probe**：确认 host 支持 emit（capability 列表含 `emit`），不支持就降级（`track` 记录 + 卡片面提醒用户）。
7. **别把 emit 当 `pi.sendMessage`**：emit = 卡片用户动作 → 上报给会话；`pi.sendMessage` = 插件侧结果 → 注入会话。两者不同通道。

## 5. 对下载插件的适用

- **投递层不用 emit**（走 `deferred:resolve` / `pi.sendMessage` 同回合）。
- **卡片 UI 交互**可用：比如卡片上"暂停/继续/取消"按钮 → `card.emit("download.cancel", {taskId})` → 唤醒 agent 处理下载干预。这是 emit 的主场。

## 6. 参考资料

- 宿主 bundle 卡片 API 文档注释 @2351645 / @2480000（win32 bundle `index.js`）
- 交互卡片设计规范（host 内置 `# Hana Interactive Card Design Handbook`）
