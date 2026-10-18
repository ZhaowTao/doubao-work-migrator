#!/usr/bin/env python3
"""把豆包Work 的 10 个项目资产对应放置到各自的本地项目文件夹。

每个有目录的项目：
  <folder>/.workbuddy/memory/doubao-import_20261019.md   摘要（对话索引，可入上下文）
  <folder>/豆包Work资产全录_<项目名>.md                    完整转录（约 MB 级，不自动加载）
无目录的项目保留在中央归档 ~/WorkBuddy/豆包Work导入/projects/。
"""
import json
import os
import re
import shutil
from datetime import datetime

SRC = '/tmp/mda/doubao_export'
CENTRAL = os.path.expanduser('~/WorkBuddy/豆包Work导入')
STAMP = '2026-10-19'


def fmt_time(ts):
    try:
        return datetime.fromtimestamp(int(ts)).strftime('%Y-%m-%d %H:%M')
    except Exception:
        return ''


def main():
    projects = json.load(open(os.path.join(SRC, 'projects_full.json'), encoding='utf-8'))
    all_msgs = json.load(open(os.path.join(SRC, 'all_messages.json'), encoding='utf-8'))
    conv_index = json.load(open(os.path.join(SRC, 'conv_index.json'), encoding='utf-8'))
    name_by_id = {c['id']: c for c in conv_index}

    placed, skipped = [], []
    for p in projects:
        name = (p.get('name') or '').strip()
        folders = [f['workspace'] for f in (p.get('folders') or []) if f.get('workspace')]
        convs = p.get('conversations') or []
        label = name or '未命名项目'
        if not folders or not all(os.path.isdir(f) for f in folders):
            skipped.append(label)
            continue
        folder = folders[0]

        # 汇总该项目的对话统计
        rows = []
        total_msgs = 0
        for c in convs:
            cid = c['conversation_id']
            data = all_msgs.get(cid, {})
            msgs = data.get('messages', [])
            total_msgs += len(msgs)
            first_ts = min((int(m.get('create_time') or 0) for m in msgs), default=0)
            rows.append((c.get('conversation_name') or '(未命名对话)', fmt_time(first_ts) or (fmt_time(c.get('create_time')) or ''), len(msgs)))
        rows.sort(key=lambda r: r[1])

        # 1) 摘要记忆文件
        safe = re.sub(r'[\\/:*?"<>|]', '_', label)
        digest = [
            '# 豆包Work 项目导入：%s（%s）' % (label, STAMP),
            '',
            '本文件由豆包Work 资产迁移自动生成（2026-10-19，DoubaoWork v2.32）。',
            '完整对话全录见同目录《豆包Work资产全录_%s.md》。' % label,
            '',
            '- 豆包项目 ID：%s' % p.get('project_id', ''),
            '- 本地目录：%s' % folder,
            '- 对话数：%d（消息共 %d 条）' % (len(convs), total_msgs),
            '',
            '## 对话索引',
            '',
            '| 对话 | 最早消息 | 消息数 |',
            '|---|---|---|',
        ]
        for r in rows:
            digest.append('| %s | %s | %d |' % (r[0].replace('|', '/'), r[1], r[2]))
        digest.append('')
        mem_dir = os.path.join(folder, '.workbuddy', 'memory')
        os.makedirs(mem_dir, exist_ok=True)
        digest_path = os.path.join(mem_dir, 'doubao-import_%s_memory.md' % STAMP.replace('-', ''))
        with open(digest_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(digest))

        # 2) 完整全录（从中央归档复制）
        src_file = os.path.join(CENTRAL, 'projects', safe + '.md')
        if not os.path.exists(src_file):
            # 未命名项目的文件名规则
            src_file = os.path.join(CENTRAL, 'projects', re.sub(r'[\\/:*?"<>|]', '_', '未命名项目_' + str(p.get('project_id', ''))[-6:]) + '.md')
        dst_file = os.path.join(folder, '豆包Work资产全录_%s.md' % label)
        if os.path.exists(src_file):
            shutil.copyfile(src_file, dst_file)
            size = os.path.getsize(dst_file)
        else:
            size = 0
        placed.append((label, folder, digest_path, dst_file, size, len(convs), total_msgs))

    print('已放置 %d 个项目到各自文件夹：' % len(placed))
    for label, folder, dpath, fpath, size, nc, nm in placed:
        print('  [%s] -> %s' % (label, folder))
        print('     摘要: %s (%d 对话/%d 消息)' % (os.path.relpath(dpath, folder), nc, nm))
        print('     全录: %s (%.1f MB)' % (os.path.basename(fpath), size / 1048576))
    if skipped:
        print('无本地目录、保留在中央归档的项目:', ', '.join(skipped))
        print('  (位置: %s/projects/)' % CENTRAL)


if __name__ == '__main__':
    main()
