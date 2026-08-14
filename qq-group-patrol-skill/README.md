# QQ 群巡检 Skill · 快速上手

让 HanaAgent 定时巡检你的 QQ 群，把群聊变成结构化简报，自动推送到微信。
读本机 NTQQ 数据库，**无条数上限**，全程离线、只读你自己的数据。

## 这套东西是什么

```
QQ 客户端（本机已登录）
   → chatlog-keeper（读本地加密库，开源工具）
   → patrol.py（本 skill 的脚本：按群 + 时间窗过滤）
   → patrol_report.json（结构化数据）
   → HanaAgent 生成巡检报告 → 推送到微信
```

核心价值：每天早/午/晚自动跑，把"今天群里聊了什么、谁发了有用的东西、
有没有新文件"变成一份可读报告，不用自己爬楼。

## 你需要准备的

1. **Python 3.9+**（`python --version` 确认）
2. **chatlog-keeper**：在 [GitHub](https://github.com/sjzar/chatlog) 找开源仓库，
   clone 后 `pip install -r requirements.txt`，放在 `scripts/patrol.py` 同级或安装到环境
3. **本机已登录 QQ**（NTQQ 9.9.x），且目标群是你自己加入的群
4. **解密密钥**（见下）

## 三步安装

### 第 1 步：提取 QQ 数据库解密密钥（一次，系统重启后可能要重做）

```powershell
# 关闭 QQ（用 wmic，别用任务管理器强杀）
Get-Process QQ* | ForEach-Object { wmic process where "processid='$($_.Id)'" call terminate }

# 管理员 PowerShell 运行（会弹调试版 QQ，扫码登录，2 分钟内完成）
powershell -ExecutionPolicy Bypass -File "<chatlog-keeper>\chatlog_keeper\scripts\windows_ntqq_get_key.ps1"

# 验证密钥已缓存（应显示 16 字符）
Get-Content "$env:LOCALAPPDATA\chatlog-keeper\data\secrets\qq_db.key"
```

### 第 2 步：找到你的群号

```bash
cd <chatlog-keeper 目录>
python -m chatlog_keeper.cli probe        # 看本机能导出什么
python listgroups.py                       # 列出群 → 找到目标群的 chat_uid
```

### 第 3 步：手动跑一次验证

```bash
cd <skill>/scripts
python patrol.py --hours 6 --chat-uid <你的群号> --chat-name "我的群" --data-root "<NTQQ数据根目录>"
# 成功则输出 ./patrol_out/patrol_report.json + patrol_report.md
```

## 配置定时巡检（HanaAgent 用户）

用 HanaAgent 的**自动化任务**（automation）创建 cron 任务：

- 早间 `30 7 * * *`（窗口 14h，详细报告）
- 午间/晚间 `0 12,18 * * *`（窗口 6h，精简报告）

Prompt 模板见 `templates/cron-prompts.md`，改三处：群号、脚本路径、输出路径。
时间用**北京时间**。

## 没有 HanaAgent？也可以手动用

不装 HanaAgent 也行：每天自己跑一次 `python patrol.py --chat-uid <群号> --data-root "<NTQQ数据根目录>"`，直接看 `patrol_out/patrol_report.md`
（已经是一份 Markdown 概览）。Agent 的价值在于自动提炼"有价值发言"并推送。

## 常见问题

| 问题 | 处理 |
|---|---|
| 报告 0 条 | 密钥失效了，重跑密钥提取 |
| "file is not a database" | 密钥不对，检查 qq_db.key |
| 找不到群号 | 用 `listgroups.py` 列全部群 |
| QQ 弹"文件损坏" | 关 QQ 用了强杀，改用 wmic terminate |

## 更新记录

- v1.1（2026-08-14）：修复 Windows 路径转义警告；补充 `--data-root` 必填说明；示例统一带全参数。

## 边界与免责

仅导出你自己账号、自己设备的数据，全程离线。使用前阅读 chatlog-keeper 的
DISCLAIMER；遵守当地法律法规与服务条款。
