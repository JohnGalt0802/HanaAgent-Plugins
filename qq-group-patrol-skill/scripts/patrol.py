r"""
QQ群巡检脚本 v3.1 - 通用版
本地 QQ 数据库直读，无消息数量限制。
从 chatlog-keeper 导出消息 → 按群 + 时间窗口过滤 → 生成 patrol_report.json + .md

用法:
  python patrol.py [--hours N] [--chat-uid UID] [--chat-name 名称]
                   [--data-root 路径] [--out-dir 路径]

输出:
  <out-dir>/patrol_report.json  +  patrol_report.md

依赖:
  chatlog_keeper 包（与本脚本同级目录，或已 pip 安装）
  密钥: 首次需提取（见 SKILL.md 或 README 的密钥提取章节），缓存于
        %LOCALAPPDATA%\chatlog-keeper\data\secrets\qq_db.key（16/32 字符）
"""
import os, sys, json, logging, subprocess, tempfile, shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections import defaultdict

logging.basicConfig(level=logging.WARNING)

# chatlog_keeper 与本脚本同级时保证可导入
sys.path.insert(0, str(Path(__file__).parent))

# 默认值（可被命令行参数覆盖）
# 默认值（可被命令行参数/环境变量覆盖；chat_uid 与 data_root 必填，否则报错）
DEFAULT_DATA_ROOT = os.environ.get('CHATLOG_QQ_DATA_ROOT', '')
DEFAULT_CHAT_UID = os.environ.get('CHATLOG_QQ_CHAT_UID', '')
DEFAULT_CHAT_NAME = os.environ.get('CHATLOG_QQ_CHAT_NAME', '群聊')
DEFAULT_OUT_DIR = os.environ.get('CHATLOG_QQ_OUT_DIR', '')  # 空则用 ./patrol_out
DEFAULT_HOURS = 6


def resolve_out_dir(path: str) -> Path:
    """out-dir 为空时默认当前目录下 patrol_out。"""
    return Path(path) if path else Path.cwd() / 'patrol_out'

KEY_PATH = Path(os.environ.get('LOCALAPPDATA', '')) / 'chatlog-keeper' / 'data' / 'secrets' / 'qq_db.key'


def ensure_key_available() -> bool:
    """确保 QQ 数据库解密密钥已缓存。"""
    if KEY_PATH.exists():
        content = KEY_PATH.read_text(encoding='utf-8').strip()
        if len(content) in (16, 32):
            return True
    return False


def fetch_from_local_db(hours: int, chat_uid: str, data_root: str) -> list:
    """从本地 NTQQ 数据库导出消息（chatlog_keeper 直读）。"""
    days = max(1, hours // 24 + 1)
    tmpdir = tempfile.mkdtemp(prefix='qqpatrol_')
    env = dict(os.environ)
    env['CHATLOG_QQ_DATA_ROOT'] = data_root

    try:
        r = subprocess.run([
            sys.executable, '-m', 'chatlog_keeper.cli', 'qq',
            '--days', str(days),
            '--out', tmpdir,
        ], capture_output=True, text=True, timeout=120,
           cwd=Path(__file__).parent, env=env)

        json_path = Path(tmpdir) / 'qq_messages.json'
        if not json_path.exists():
            logging.error(f"Export failed: {r.stderr[:500]}")
            return []

        with open(json_path, 'r', encoding='utf-8') as f:
            all_msgs = json.load(f)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    # 按 chat_uid 与时间窗口过滤
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=hours)

    msgs = [m for m in all_msgs
            if str(m.get('chat_uid', '')) == chat_uid
            and m.get('ts_iso')
            and datetime.fromisoformat(m['ts_iso'].replace('Z', '+00:00')) >= cutoff]

    return msgs


def build_report(msgs: list, chat_uid: str, chat_name: str, hours: int) -> dict:
    text_msgs = []
    file_msgs = []
    image_count = 0
    senders = defaultdict(int)

    for m in msgs:
        sender = m.get('sender_name', '?').strip()
        senders[sender] += 1

        att = m.get('attachment_meta')
        if att:
            kind = att.get('kind', '')
            if kind == 'file':
                file_msgs.append({
                    'sender': sender,
                    'filename': att.get('filename', 'unknown'),
                    'size_bytes': att.get('total_bytes', 0),
                    'time': m.get('ts_iso', ''),
                    'context': m.get('content', '')[:200],
                })
            elif kind == 'image':
                image_count += 1

        content = m.get('content', '')
        if content:
            text_msgs.append({'sender': sender, 'content': content, 'time': m.get('ts_iso', '')})

    top = sorted(senders.items(), key=lambda x: -x[1])[:10]
    recent_texts = text_msgs[-50:]
    # Mozi 动态板块：把群主/核心维护者的发言单独成组，便于 Agent 总结
    mozi_keywords = ('mozi', 'lilimozi', 'lili mozi')
    mozi_msgs = [t for t in text_msgs if t['sender'].lower() in mozi_keywords]

    return {
        'chat_uid': chat_uid,
        'chat_name': chat_name,
        'hours': hours,
        'total_messages': len(msgs),
        'text_messages': len(text_msgs),
        'image_count': image_count,
        'file_count': len(file_msgs),
        'active_members': len(senders),
        'top_talkers': dict(top[:10]),
        'recent_messages': [{'sender': t['sender'], 'content': t['content'][:500]} for t in recent_texts[-30:]],
        'all_messages': [{'sender': t['sender'], 'content': t['content'][:500]} for t in text_msgs],
        'mozi_messages': [{'sender': t['sender'], 'content': t['content'][:500]} for t in mozi_msgs],
        'mozi_count': len(mozi_msgs),
        'files': file_msgs,
        '_source': 'local_db',
    }


def format_markdown(report: dict) -> str:
    lines = []
    lines.append(f"# 📋 {report['chat_name']} 巡检报告")
    lines.append(f"**巡检时间**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**统计范围**: 最近 {report['hours']} 小时")
    lines.append("")
    lines.append(f"## 📊 数据概览")
    lines.append(f"- 总消息: **{report['total_messages']}** 条")
    lines.append(f"- 文本消息: {report.get('text_messages', 0)} 条")
    lines.append(f"- 图片: {report.get('image_count', 0)} 张")
    lines.append(f"- 群文件: {report.get('file_count', 0)} 个")
    lines.append(f"- 活跃成员: {report.get('active_members', 0)} 人")
    lines.append("")

    if report.get('top_talkers'):
        lines.append(f"## 👥 活跃排行")
        for name, cnt in list(report['top_talkers'].items())[:8]:
            lines.append(f"- **{name}**: {cnt} 条")
        lines.append("")

    if report.get('recent_messages'):
        lines.append(f"## 💬 近期消息")
        for m in report['recent_messages'][-15:]:
            lines.append(f"- **{m['sender']}**: {m['content'][:200]}")
        lines.append("")

    if report.get('files'):
        lines.append(f"## 📁 群文件")
        for f in report['files']:
            size_str = f"{f['size_bytes']/1024:.1f}KB" if f['size_bytes'] < 1024*1024 else f"{f['size_bytes']/1024/1024:.1f}MB"
            lines.append(f"- **{f['filename']}** ({size_str}) by {f['sender']}")
            desc = f.get('context', '')
            if desc and desc != f.get('filename', ''):
                lines.append(f"  - {desc[:200]}")
        lines.append("")

    lines.append(f"---\n*由 HanaAgent 自动生成*")
    return '\n'.join(lines)


def main():
    import argparse
    p = argparse.ArgumentParser(description='QQ群巡检：本地数据库直读，无条数限制')
    p.add_argument("--hours", type=int, default=DEFAULT_HOURS, help="时间窗口（小时），默认 6")
    p.add_argument("--chat-uid", default=DEFAULT_CHAT_UID, help="目标群号（chat_uid），默认取环境变量或内置值")
    p.add_argument("--chat-name", default=DEFAULT_CHAT_NAME, help="群名（仅用于报告展示），默认取环境变量或'群聊'")
    p.add_argument("--data-root", default=DEFAULT_DATA_ROOT, help="QQ 数据根目录（如 C:\\Users\\你\\Documents\\Tencent Files），必填")
    p.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help="报告输出目录")
    args = p.parse_args()

    if not args.chat_uid:
        p.error("--chat-uid 必填（找不到群号时用 listgroups.py 列出）")
    if not args.data_root:
        p.error("--data-root 必填（NTQQ 数据根目录，通常为 %USERPROFILE%\\Documents\\Tencent Files）")

    out_dir = resolve_out_dir(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if not ensure_key_available():
        print("ERROR: NTQQ key not cached. Run key extraction first (see SKILL.md / README).")
        sys.exit(1)

    print(f"Exporting local DB for group {args.chat_uid} ({args.chat_name}, last {args.hours}h)...")
    msgs = fetch_from_local_db(args.hours, args.chat_uid, args.data_root)

    if not msgs:
        print(f"No messages in last {args.hours}h")
        report = {
            "chat_uid": args.chat_uid, "chat_name": args.chat_name,
            "hours": args.hours, "total_messages": 0, "text_messages": 0,
            "image_count": 0, "file_count": 0, "active_members": 0,
            "top_talkers": {}, "recent_messages": [], "mozi_messages": [],
            "mozi_count": 0, "files": [], "_source": "local_db",
        }
    else:
        report = build_report(msgs, args.chat_uid, args.chat_name, args.hours)
        report["_raw_total"] = len(msgs)

    json_out = out_dir / 'patrol_report.json'
    md_out = out_dir / 'patrol_report.md'
    with open(json_out, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    with open(md_out, 'w', encoding='utf-8') as f:
        f.write(format_markdown(report))

    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"\nReports: {json_out}, {md_out}")


if __name__ == '__main__':
    main()
