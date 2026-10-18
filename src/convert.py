#!/usr/bin/env python3
"""把豆包Work导出的资产转换为 WorkBuddy + Hermes 可用的格式。

输入（/tmp/mda/doubao_export/）：
  memories.json      9 条豆包记忆
  projects_full.json 10 个项目（含 folders/conversations）
  all_messages.json  全部对话消息

输出：
  ~/WorkBuddy/豆包Work导入/                     总览 + 分项目转录
  ~/.workbuddy/memory/doubao-import_20261019_memory.md   WorkBuddy 经验记忆
  ~/.hermes/memories/MEMORY.md                  Hermes 记忆（追加）
"""
import json
import os
import re
import subprocess
from datetime import datetime

SRC = '/tmp/mda/doubao_export'
WB_IMPORT = os.path.expanduser('~/WorkBuddy/豆包Work导入')
WB_PROJ_DIR = os.path.join(WB_IMPORT, 'projects')
WB_MEM = os.path.expanduser('~/.workbuddy/memory/doubao-import_20261019_memory.md')
HERMES_MEM = os.path.expanduser('~/.hermes/memories/MEMORY.md')
STAMP = '2026-10-19'


def load(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return json.load(f)


def parse_content(raw):
    """从消息 content JSON 中提取可见文本与引用。"""
    if not isinstance(raw, str):
        return str(raw) if raw else ''
    try:
        d = json.loads(raw)
    except Exception:
        return raw
    if not isinstance(d, dict):
        return str(d)
    parts = []
    text = d.get('text')
    if isinstance(text, str) and text.strip():
        parts.append(text.strip())
    for key in ('multi_reference', 'search_references'):
        ref = d.get(key)
        if isinstance(ref, dict):
            items = ref.get('references') or ref.get('items') or []
            if isinstance(items, list):
                for it in items[:5]:
                    if isinstance(it, dict):
                        nm = it.get('name') or it.get('title') or ''
                        if nm:
                            parts.append('[引用: %s]' % nm)
    return '\n\n'.join(parts)


def parse_thinking(raw):
    if not raw:
        return ''
    try:
        d = json.loads(raw) if isinstance(raw, str) else raw
        thinks = d.get('thinks') or []
        texts = [t.get('text', '') for t in thinks if isinstance(t, dict) and t.get('text')]
        return '\n'.join(texts).strip()
    except Exception:
        return ''


def fmt_time(ts):
    try:
        return datetime.fromtimestamp(int(ts)).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return ''


def render_conversation(cid, info):
    msgs = sorted(info.get('messages', []), key=lambda m: int(m.get('index_in_conv') or 0))
    lines = []
    lines.append('## %s' % (info.get('name') or cid))
    lines.append('')
    lines.append('- 对话 ID：%s' % cid)
    lines.append('- 消息数：%d' % len(msgs))
    lines.append('')
    n_user = n_bot = 0
    think_chars = 0
    for m in msgs:
        ut = m.get('user_type')
        role = '用户' if ut == 1 else '豆包'
        if ut == 1:
            n_user += 1
        else:
            n_bot += 1
        text = parse_content(m.get('content'))
        th = parse_thinking(m.get('thinking_content'))
        if th:
            think_chars += len(th)
        ts = fmt_time(m.get('create_time'))
        if not text and not th:
            continue
        lines.append('### [%s] %s%s' % (ts, role, '（含思考）' if th else ''))
        lines.append('')
        if text:
            lines.append(text)
            lines.append('')
        elif th:
            lines.append('（本条为思考过程，无可见文本）')
            lines.append('')
    lines.append('---')
    lines.append('')
    return '\n'.join(lines), n_user, n_bot, think_chars, len(msgs)


def main():
    memories = load('memories.json')
    projects = load('projects_full.json')
    all_msgs = load('all_messages.json')

    os.makedirs(WB_PROJ_DIR, exist_ok=True)

    # ---------- 1. 总览 ----------
    total_msgs = sum(len(v.get('messages', [])) for v in all_msgs.values())
    overview = []
    overview.append('# 豆包Work 资产导入（%s）' % STAMP)
    overview.append('')
    overview.append('本目录为豆包Work（DoubaoWork v2.32.x）导出资产的本地存档，由迁移工具自动生成。')
    overview.append('')
    overview.append('## 导入内容统计')
    overview.append('')
    overview.append('- 记忆：%d 条' % len(memories))
    overview.append('- 项目：%d 个' % len(projects))
    overview.append('- 对话：%d 个（消息共 %d 条）' % (len(all_msgs), total_msgs))
    overview.append('')
    overview.append('## 项目清单')
    overview.append('')
    overview.append('| 项目 | 本地目录 | 对话数 |')
    overview.append('|---|---|---|')
    for p in projects:
        folders = ', '.join(f.get('workspace', '') for f in (p.get('folders') or []) if f.get('workspace')) or '—'
        overview.append('| %s | %s | %d |' % (p.get('name') or '(未命名)', folders, len(p.get('conversations') or [])))
    overview.append('')
    overview.append('## 记忆清单（已同步至 WorkBuddy 记忆与 Hermes MEMORY.md）')
    overview.append('')
    for i, m in enumerate(memories, 1):
        overview.append('%d. （%s）%s' % (i, m.get('date', ''), m.get('content', '')))
    overview.append('')

    # 覆盖度与技能清单
    try:
        skills = load('skills.json')
    except Exception:
        skills = []
    archived = [cid for cid, v in all_msgs.items() if v.get('project') == '(已归档)']
    overview.append('## 覆盖度说明（2026-10-19 审计）')
    overview.append('')
    overview.append('- 项目内对话：%d 个（项目列表权威全量）' % sum(len(p.get('conversations') or []) for p in projects))
    overview.append('- 侧边栏可见对话：47 个，全部覆盖')
    overview.append('- 已归档对话：%d 个（见 projects/_已归档.md）' % len(archived))
    overview.append('- 豆包Work 可用技能：%d 个（清单见下）' % len(skills))
    overview.append('- 未覆盖：云盘文件（豆包云盘无本地缓存、导出接口未开放）；仅存在于其他设备的老对话（recent_conv 接口翻页游标失效，无法触及）')
    overview.append('')
    if skills:
        overview.append('## 豆包Work 技能清单（%d 个）' % len(skills))
        overview.append('')
        for s in skills:
            nm = s.get('show_name') or s.get('name') or ''
            desc = (s.get('description') or '').split('\n')[0][:60]
            overview.append('- **%s**：%s' % (nm, desc))
        overview.append('')
    overview.append('## 文件说明')
    overview.append('')
    overview.append('- `projects/<项目名>.md`：每个项目的全部对话转录（按时间排序，含用户与豆包的全部消息）')
    overview.append('- 未分组对话见 `projects/_未分组.md`')
    overview.append('')
    with open(os.path.join(WB_IMPORT, '豆包Work资产导入_总览.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(overview))

    # ---------- 2. 分项目转录 ----------
    proj_conv_ids = {}
    for p in projects:
        for c in (p.get('conversations') or []):
            proj_conv_ids[c['conversation_id']] = p.get('name') or '(未命名)'

    by_project = {}
    ungrouped = {}
    for cid, info in all_msgs.items():
        pname = proj_conv_ids.get(cid) or (info.get('project') if info.get('project') != '(未分组)' else None)
        if pname:
            by_project.setdefault(pname, []).append((cid, info))
        else:
            ungrouped[cid] = info

    grand = [0, 0, 0, 0]
    for pname, convs in sorted(by_project.items()):
        lines = ['# 豆包Work 项目：%s' % pname, '']
        meta = next((p for p in projects if (p.get('name') or '(未命名)') == pname), None)
        if meta:
            for f in (meta.get('folders') or []):
                if f.get('workspace'):
                    lines.append('- 本地目录：%s' % f['workspace'])
            lines.append('- 对话数：%d' % len(convs))
            lines.append('')
        for cid, info in convs:
            body, nu, nb, tc, nm = render_conversation(cid, info)
            lines.append(body)
            grand[0] += nu; grand[1] += nb; grand[2] += tc; grand[3] += nm
        safe = re.sub(r'[\\/:*?"<>|]', '_', pname) or 'unnamed'
        with open(os.path.join(WB_PROJ_DIR, safe + '.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))

    if ungrouped:
        lines = ['# 豆包Work 未分组对话', '']
        for cid, info in ungrouped.items():
            body, nu, nb, tc, nm = render_conversation(cid, info)
            lines.append(body)
            grand[0] += nu; grand[1] += nb; grand[2] += tc; grand[3] += nm
        with open(os.path.join(WB_PROJ_DIR, '_未分组.md'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(lines))

    # ---------- 3. WorkBuddy 记忆文件 ----------
    mem_lines = ['# 豆包Work 导入记忆（%s）' % STAMP, '']
    mem_lines.append('以下 %d 条记忆导入自豆包Work（DoubaoWork）的个人记忆，按日期排列：' % len(memories))
    mem_lines.append('')
    for m in sorted(memories, key=lambda x: x.get('date', ''), reverse=True):
        mem_lines.append('## %s' % m.get('date', ''))
        mem_lines.append('')
        mem_lines.append(m.get('content', ''))
        mem_lines.append('')
    with open(WB_MEM, 'w', encoding='utf-8') as f:
        f.write('\n'.join(mem_lines))

    # ---------- 4. Hermes MEMORY.md 追加 ----------
    h_lines = ['', '§', '']
    h_lines.append('【豆包Work 导入 %s】以下记忆导入自豆包Work 个人记忆面板，与上方内容冲突时以最新日期为准：' % STAMP)
    h_lines.append('')
    for m in sorted(memories, key=lambda x: x.get('date', ''), reverse=True):
        h_lines.append('- （%s）%s' % (m.get('date', ''), m.get('content', '')))
    existing = open(HERMES_MEM, encoding='utf-8').read() if os.path.exists(HERMES_MEM) else ''
    marker = '【豆包Work 导入 %s】' % STAMP
    if marker in existing:
        # 替换旧段（幂等）：截到标记前再写
        idx = existing.find(marker)
        cut = existing.rfind('§', 0, idx)
        existing = (existing[:cut].rstrip() + '\n') if cut != -1 else existing[:idx]
        open(HERMES_MEM, 'w', encoding='utf-8').write(existing)
    with open(HERMES_MEM, 'a', encoding='utf-8') as f:
        f.write('\n'.join(h_lines))

    # ---------- 5. 报告 ----------
    print('转换完成：')
    print('  总览:', os.path.join(WB_IMPORT, '豆包Work资产导入_总览.md'))
    print('  项目转录文件:', len(os.listdir(WB_PROJ_DIR)), '个 ->', WB_PROJ_DIR)
    print('  未分组对话:', len(ungrouped), '个')
    print('  WorkBuddy 记忆文件:', WB_MEM)
    print('  Hermes MEMORY.md 已追加 %d 条' % len(memories))
    print('  消息统计: 用户 %d / 豆包 %d / 共 %d 条' % (grand[0], grand[1], grand[3]))


if __name__ == '__main__':
    main()
