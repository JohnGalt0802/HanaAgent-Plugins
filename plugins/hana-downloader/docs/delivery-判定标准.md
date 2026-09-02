# 投递判定标准（同步 / 异步）

> 落盘：2026-09-01
> 目的：这是下载完成/终态消息投递的**唯一判定标准**。任何"同步"/"异步"的判断，必须按本标准实测，**禁止凭 jsonl 配对 / 日志关键字臆断**。
> 本文件是重做 0.9.1 投递层的判定基石。

---

## 1. 定义（用户确认）

- **同步**：下载完成消息，在会话**「未收束」**时，作为**当前回合的 input** 到达 agent，agent 在**同一个未收束回合**里感知并回应。
- **异步**：下载完成消息，在会话**「已收束」**（agent 停止）后到达，需要**唤起一个新回合**才交回 agent。

**一句话**：同步 = 未收束回合内到达；异步 = 收束后唤醒新回合才到达。

---

## 2. 实测判定（看 jsonl，2 步）

### 第 1 步：判会话是否收束
找 jsonl **最后一条真实 message**（跳过 custom/custom_message/turn_input_consumption 等记账条目）：
- `assistant + stopReason===“stop"` → **收束**（settled）
- `assistant + stopReason!=="stop"`（toolUse 等） / `toolResult` / `user` → **未收束**（unsettled）

### 第 2 步：看下载完成消息 entry 的位置 + agent 后续生成
- 下载完成 entry（`custom_message customType=hana-background-result` 或 `role=toolResult`）在**未收束**时到达，且 agent 紧接着**同回合继续生成**（下一条 assistant，无收束间隔）感知并回应它 → **同步**
- 下载完成 entry 在**收束**（assistant+stop）之后到达，唤起**新的 assistant 生成回合**（新 turn）才交回 → **异步**

---

## 3. 判据红线（易错，必须记住）

- ❌ **`custom_message + turn_input_consumption 配对` ≠ 异步**。它只是宿主记录"这条 input 被消费"，**同步投递同样产生**。
- ❌ **日志 `STEER(queue) sent` / `BUS-STEER(...)` ≠ 真同步**。它只表示插件调用了某通道，**不代表消息成为回合内 input**。
- ✅ **唯一真判据 = 消息在未收束回合内到达 + agent 同回合回应**（jsonl 顶层结构判断）。
- ✅ **channel 是否"原生"用宿主已有 API；不能靠魔改 bundle 造通道**（0.9.1 原则）。

---

## 4. 记录规范

- 每次测试，先写**① 会话收束与否 ② 消息 entry 位置 ③ agent 回应是否同回合**，再下"同步/异步"结论。
- 结论标成色：**实测** / **代码推断**，不得混写。
