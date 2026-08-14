# HanaAgent-Plugins

HanaAgent 插件公开集合。每个插件独立目录，即开即用。

## 插件列表

| 插件 | 版本 | 说明 |
|---|---|---|
| [ns-new-session](plugins/ns-new-session/) | 1.0.0 | `/ns` 快捷命令：新建桌面级会话，弥补移动端 `/new` 不能创建桌面会话的问题 |
| [download-progress](plugins/download-progress/) | 1.6.0 | 下载进度条：Agent 下载文件时显示实时进度卡片（百分比/总大小/速度/已完成量），支持限速、wait 回查、断点恢复、停滞检测 |
| [qq-group-patrol-skill](qq-group-patrol-skill/) | 1.1 | QQ 群定时巡检 skill：chatlog-keeper 直读本地库，生成数据概览/群友有价值发言/群文件巡检报告，可 cron 定时推微信 |

## 安装

把目标插件目录复制到 Hana 插件目录：

```bash
# 以 download-progress 为例
cp -r plugins/download-progress <Hana插件目录>/download-progress
```

或在 Hana 设置 → 插件中直接安装。

## 说明

- 插件按需更新，版本见各插件 manifest.json
- 公开分发用仓库；日常开发请用私有仓库
- 各插件 README 内含完整使用文档与踩坑记录
