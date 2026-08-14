# cron 定时巡检 Prompt 模板

复制到 HanaAgent 自动化任务（automation）的 prompt 字段，按实际情况替换
`<chat_uid>`、`<scripts 目录>`、`<out-dir>`、`<群名>`、`<NTQQ数据根目录>`。

## 早间详细版（cron: `30 7 * * *`，窗口 14 小时）

```
不要派子代理，不做任何子代理/subagent/sub_agent/task 调用。

中文思维启动

执行 QQ 群「<群名>」巡检，chat_uid=<chat_uid>。

1. cd <scripts 目录> && python patrol.py --hours 14 --chat-uid <chat_uid> --chat-name "<群名>" --data-root "<NTQQ数据根目录>"
2. 读取 <out-dir>/patrol_report.json
3. 生成详细纯文本巡检报告（不限长度）

报告板块要求：
• 数据概览（消息量、图片数、文件数、活跃人数、TOP10 发言）
• 群友有价值发言（核心板块）：
  - 从 patrol_report 的所有消息中，逐条提取有实操价值的发言
  - 每条标注发言人 + 具体内容，不限条数
  - 不要写"群内讨论了XX话题"这种概括句，写具体的人说了具体什么
  - 被水群淹没的小技巧常常是最有用的，要仔细捞
• Mozi 动态：从 mozi_messages 逐条总结
• 群文件
• 异常/需关注事项

禁止写"以水群为主""其余为日常吹水"等偷懒概括。

4. 推送微信：notify(channels=["bridge_owner"], bridgePlatforms=["wechat"], title="📋 <群名>巡检 MM-DD")

纯文本格式，不用套话收尾。
```

## 午间/晚间精简版（cron: `0 12,18 * * *`，窗口 6 小时）

```
不要派子代理，不做任何子代理/subagent/sub_agent/task 调用。

执行 QQ 群「<群名>」巡检，chat_uid=<chat_uid>。

步骤：
1. cd <scripts 目录> && python patrol.py --hours 6 --chat-uid <chat_uid> --chat-name "<群名>" --data-root "<NTQQ数据根目录>"
2. 读取 <out-dir>/patrol_report.json
3. 生成详细纯文本巡检报告

报告板块：
• 数据概览（消息量、活跃人数、TOP10 发言）
• 群友有价值发言：逐条提取实操发言，标注发言人+具体内容
• Mozi 动态
• 异常/需关注事项

完成后推送微信：notify(channels=["bridge_owner"], bridgePlatforms=["wechat"], title="📋 <群名>巡检（午间/晚间）")
纯文本，不用套话。
```

## 创建自动化任务的注意事项

1. **时间一律用北京时间（UTC+8）**：`automation` 的 cron 表达式按北京时间解释
2. **必须显式禁止子代理**：cron 后台任务不允许子代理调用，写进 prompt 第一行
3. **模型用 deepseek-v4-flash**（或你日常主模型），成本低
4. **mode 用 isolated**（独立会话执行，不污染主会话）
5. **推送目标**：`notify(channels=["bridge_owner"], bridgePlatforms=["wechat"])`，按你自己的桥接平台改（wechat/qq/telegram 等）
