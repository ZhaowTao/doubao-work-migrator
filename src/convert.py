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
import shutil
import subprocess
from datetime import datetime

SRC = os.path.join(os.environ.get('DOUBAO_WORK_DIR', os.path.expanduser('~/.doubao-migrator')), 'export')
WB_IMPORT = os.path.expanduser('~/WorkBuddy/豆包Work导入')
WB_PROJ_DIR = os.path.join(WB_IMPORT, 'projects')
# 稳定文件名：每次覆盖写，避免按日期堆出多份重复记忆
WB_MEM = os.path.expanduser('~/.workbuddy/memory/doubao-import_memory.md')
HERMES_MEM = os.path.expanduser('~/.hermes/memories/MEMORY.md')
STAMP = datetime.now().strftime('%Y-%m-%d')
HERMES_MARKER = '【豆包Work 记忆同步】'


def load(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return json.load(f)


def near_dup_pairs(memories, threshold=0.72):
    """找出语义近似重复的记忆（豆包自身不做去重，会累积同义条目）。"""
    import difflib

    def norm(s):
        return re.sub(r'[\s，。、；：""\'\'（）()\-—、]+', '', s or '')

    pairs = []
    texts = [(i, norm(m.get('content', ''))) for i, m in enumerate(memories)]
    for a in range(len(texts)):
        for b in range(a + 1, len(texts)):
            r = difflib.SequenceMatcher(None, texts[a][1], texts[b][1]).ratio()
            if r >= threshold:
                pairs.append((a, b, round(r, 2)))
    return pairs


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
    # content_type=20 的图片/文件消息：正文在 entities 里，只取 text 会把整条消息丢掉
    ents = d.get('entities')
    if isinstance(ents, list):
        for e in ents:
            if not isinstance(e, dict):
                continue
            ec = e.get('entity_content')
            if not isinstance(ec, dict):
                continue
            img = ec.get('image')
            if isinstance(img, dict):
                ori = img.get('image_ori') or {}
                url = ori.get('url') or ''
                key = img.get('key') or ''
                if url or key:
                    parts.append('![图片](%s)' % (url or key))
                continue
            fl = ec.get('file')
            if isinstance(fl, dict):
                nm = fl.get('file_name') or fl.get('name') or '文件'
                url = fl.get('url') or (fl.get('file_ori') or {}).get('url') or ''
                parts.append('[文件：%s](%s)' % (nm, url) if url else '[文件：%s]' % nm)
                continue
            for k in ('text', 'content', 'name', 'title'):
                v = ec.get(k)
                if isinstance(v, str) and v.strip():
                    parts.append(v.strip())
                    break
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

    # 供覆盖度说明使用的统计
    proj_ids = {c['conversation_id'] for p in projects for c in (p.get('conversations') or [])}
    ungrouped_ids = [cid for cid in all_msgs if cid not in proj_ids]
    media_count = sum(
        1 for v in all_msgs.values() for m in v.get('messages', [])
        if '"entities"' in str(m.get('content', ''))
    )

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
    dups = near_dup_pairs(memories)
    if dups:
        overview.append('### 可能重复的记忆（豆包不做去重，建议在面板里手动合并）')
        overview.append('')
        for a, b, r in dups:
            overview.append('- 相似度 %s：第 %d 条 ≈ 第 %d 条' % (r, a + 1, b + 1))
        overview.append('')

    # 覆盖度与技能清单
    try:
        skills = load('skills.json')
    except Exception:
        skills = []
    archived = [cid for cid, v in all_msgs.items() if v.get('project') == '(已归档)']
    overview.append('## 覆盖度说明（%s 同步）' % STAMP)
    overview.append('')
    overview.append('- 项目内对话：%d 个（项目列表权威全量）' % sum(len(p.get('conversations') or []) for p in projects))
    overview.append('- 未分组/已归档对话：%d 个（见 projects/_未分组.md、_已归档.md）' % len(ungrouped_ids))
    overview.append('- 已归档对话：%d 个' % len(archived))
    overview.append('- 豆包Work 可用技能：%d 个（清单见下）' % len(skills))
    overview.append('- 消息内图片/文件：%d 条（以 Markdown 图片/链接形式嵌入转录）' % media_count)
    overview.append('- 未覆盖：云盘文件（无导出接口）；仅存在于其他设备的对话（recent_conv 翻页游标失效）；伙伴(bot)独立记忆（仅主账号）')
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
    by_date = {}
    for m in sorted(memories, key=lambda x: x.get('date', ''), reverse=True):
        by_date.setdefault(m.get('date', ''), []).append(m.get('content', ''))
    for dt, items in by_date.items():
        mem_lines.append('## %s' % (dt or '（无日期）'))
        mem_lines.append('')
        for c in items:
            mem_lines.append('- %s' % c.replace('\n', ' ').strip())
        mem_lines.append('')
    with open(WB_MEM, 'w', encoding='utf-8') as f:
        f.write('\n'.join(mem_lines))
    # 旧版按日期命名的记忆文件归档，避免多份近似记忆被同时注入上下文
    wb_mem_dir = os.path.dirname(WB_MEM)
    for old in os.listdir(wb_mem_dir):
        if re.match(r'^doubao-import_\d{8}_memory\.md$', old):
            arc = os.path.join(wb_mem_dir, '_archive')
            os.makedirs(arc, exist_ok=True)
            shutil.move(os.path.join(wb_mem_dir, old), os.path.join(arc, old))

    # ---------- 4. Hermes MEMORY.md 同步段（稳定标记，每次替换） ----------
    h_lines = ['', '§', '']
    h_lines.append('%s 最近同步 %s，共 %d 条。以下记忆同步自豆包Work 个人记忆，与上方内容冲突时以最新日期为准：' % (HERMES_MARKER, STAMP, len(memories)))
    h_lines.append('')
    for m in sorted(memories, key=lambda x: x.get('date', ''), reverse=True):
        h_lines.append('- （%s）%s' % (m.get('date', ''), m.get('content', '')))
    existing = open(HERMES_MEM, encoding='utf-8').read() if os.path.exists(HERMES_MEM) else ''
    if HERMES_MARKER in existing:
        # 替换旧段（幂等）：截到标记所在 § 之前
        idx = existing.find(HERMES_MARKER)
        cut = existing.rfind('§', 0, idx)
        existing = (existing[:cut].rstrip() + '\n') if cut != -1 else existing[:idx]
    # 兼容旧的按日期标记（2026-10-19 版）
    old_marker = '【豆包Work 导入 '
    if old_marker in existing:
        idx = existing.find(old_marker)
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
