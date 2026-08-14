---
name: qq-group-patrol
description: QQ 群定时巡检。读取本机 NTQQ 聊天数据库（chatlog-keeper 直读，无条数上限），按群+时间窗口过滤生成结构化 JSON，由 Agent 提炼为数据概览/群友有价值发言/群主动态/群文件/异常关注的巡检报告，可 cron 定时自动巡检并推送微信。Triggers: 群巡检、巡检报告、群动态总结、群聊日报、跑一下巡检、QQ群监控、patrol、group patrol、群友发言提取、今天群里聊了啥。
---

# QQ 群巡检（qq-group-patrol）

让 HanaAgent 定时巡检 QQ 群，把群聊从"信息洪水"变成"结构化简报"。
读的是**本机 NTQQ 数据库**（chatlog-keeper 直读，无条数上限），全程离线、只读自己账号的数据。

## 架构总览

```
QQ 客户端（本机已登录）
   │  本地 NTQQ 数据库 nt_msg.db（SQLCipher 加密）
   ▼
chatlog-keeper（开源工具，读库 + 解密）
   │  python -m chatlog_keeper.cli qq --days N
   ▼
scripts/patrol.py（本 skill 自带，通用化）
   │  按 --chat-uid 过滤群、按 --hours 过滤时间窗
   ▼
patrol_report.json（数据概览/TOP发言/全部消息/群文件/Mozi消息）
   ▼
Agent 读取 JSON → 生成巡检报告 → notify 推送微信
   ▼
cron 定时任务（早/午/晚，见 templates/cron-prompts.md）
```

## 前置依赖（一次性安装）

1. **Python 3.9+**（要求已装 pip）
2. **chatlog-keeper**：与 `patrol.py` 同级目录，或 pip 安装
   ```bash
   git clone https://github.com/sjzar/chatlog   # 或你的 chatlog-keeper 仓库
   cd chatlog-keeper && pip install -r requirements.txt
   ```
3. **本机已登录目标群所在的 QQ**（NTQQ 9.9.x）
4. **解密密钥**：见下节「密钥提取」。密钥缓存在
   `%LOCALAPPDATA%\chatlog-keeper\data\secrets\qq_db.key`（16 或 32 字符）

## 密钥提取（系统重启后通常只需一次）

密钥用于解密本机 NTQQ 数据库。**系统重启后旧密钥可能失效**，症状是巡检报告 0 条。

```powershell
# 1) 关闭 QQ（用 wmic，别用 Stop-Process -Force，否则登录态丢失）
Get-Process QQ* | ForEach-Object { wmic process where "processid='$($_.Id)'" call terminate }

# 2) 管理员权限运行提取脚本（会弹出一个调试版 QQ 窗口）
powershell -ExecutionPolicy Bypass -File `
  "<chatlog-keeper 目录>\chatlog_keeper\scripts\windows_ntqq_get_key.ps1"

# 3) 在弹出的 QQ 窗口扫码登录（2 分钟内），脚本自动捕获密钥 → 验证 → 缓存 → 退出

# 4) 验证
Get-Content "$env:LOCALAPPDATA\chatlog-keeper\data\secrets\qq_db.key"
# 应显示 16 字符密钥（如 MA-TVc(#kHek!}pQ）

# 5) 重新启动 QQ
```

> 封号风险：读本地库 ≈ 0 风险；被动内存扫描取 key 低风险（社区主流工具长期采用）；
> 调试器方式（active）中高风险，仅自动取不到时用。绝不用于服务器侧自动化操作。

## 配置（一次性）

用环境变量或命令行参数覆盖默认值：

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--chat-uid` | `CHATLOG_QQ_CHAT_UID` | **必填** | 目标群号。怎么找：`python -m chatlog_keeper.cli probe` 或 `listgroups.py` |
| `--chat-name` | `CHATLOG_QQ_CHAT_NAME` | `群聊` | 群名（仅报告展示用） |
| `--data-root` | `CHATLOG_QQ_DATA_ROOT` | **必填** | NTQQ 数据根目录（通常 `%USERPROFILE%\Documents\Tencent Files`） |
| `--out-dir` | `CHATLOG_QQ_OUT_DIR` | `./patrol_out` | 报告输出目录 |
| `--hours` | — | `6` | 时间窗口（小时） |

示例：
```bash
python patrol.py --chat-uid 123456789 --chat-name "我的技术群" --data-root "%USERPROFILE%\Documents\Tencent Files" --hours 6
```

## 使用

### 手动跑一次

```bash
cd <skill 目录>/scripts
python patrol.py --chat-uid <群号> --data-root "<NTQQ数据根目录>" --hours 6
# 输出: ./patrol_out/patrol_report.json + patrol_report.md
```

### Agent 生成巡检报告（核心流程）

1. 运行：`cd <scripts 目录> && python patrol.py --chat-uid <群号> --data-root "<NTQQ数据根目录>" --hours N`
2. 读取 `<out-dir>/patrol_report.json`
3. 按「报告规范」生成报告（见下）
4. （可选）推送：`notify(channels=["bridge_owner"], bridgePlatforms=["wechat"], title="📋 群巡检 MM-DD")`

### cron 定时巡检（HanaAgent 配置）

完整 prompt 模板见 `templates/cron-prompts.md`。标准节奏：

| 档位 | cron | 窗口 | 报告侧重 |
|---|---|---|---|
| 早间 | `30 7 * * *` | 14h | 详细版：数据概览/有价值发言/Mozi动态/群文件/异常 |
| 午间 | `0 12 * * *` | 6h | 精简版 |
| 晚间 | `0 18 * * *` | 6h | 精简版 |

cron 任务 prompt 要点：
- **禁止子代理**（cron 任务不开子代理）
- 明确 `chat_uid`、脚本路径、输出路径
- 报告板块要求写具体：逐条提取有价值发言、标注发言人、禁止"以水群为主"等偷懒概括

## 报告规范（Agent 生成报告时遵守）

**数据概览**：消息量、图片数、文件数、活跃人数、TOP10 发言
**群友有价值发言（核心板块）**：
- 从 `all_messages` 逐条提取有实操价值的发言
- 每条标注发言人 + 具体内容，不限条数
- 不写"群内讨论了XX话题"这类概括句
- 被水群淹没的小技巧往往最有用，仔细捞
**Mozi 动态**：从 `mozi_messages` 逐条总结（群主/维护者发言）
**群文件**：文件名 + 大小 + 发送人 + 描述
**异常/需关注事项**：如新插件发布、版本兼容问题、争议话题

禁止写"以水群为主""其余为日常吹水"等偷懒概括。

## 故障排查速查表

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 报告 0 条 | 密钥失效（系统重启后） | 重跑密钥提取流程 |
| 报告始终 ≤100 条 | 用了 API 版脚本 | 确认 `_source: "local_db"` |
| "file is not a database" | 密钥不对/路径错 | 检查 qq_db.key 存在且 16 字符 |
| chatlog_keeper 导入失败 | 不在 path | patrol.py 已内置 `sys.path.insert(0, parent)`，从 scripts 目录跑 |
| 导出超时 | 数据库过大 | 减小 `--days`（patrol.py 自动按 hours 折算） |

## 边界与免责

- 仅导出**你自己账号、你自己设备**上的数据，全程离线
- 解密密钥取自本机已登录客户端，不联网、不上传
- 使用前阅读 chatlog-keeper 的 DISCLAIMER；遵守当地法律法规与服务条款
