# 架构与数据流

## 数据流

```
豆包Work 客户端 ──CDP(9222)──▶ Node 脚本（src/*.js）
                                  │ 同源 fetch（www.doubao.com target 内）
                                  ▼
                              豆包 API
                                  │
                                  ▼
                    中间产物（WORK_DIR，默认 ~/.doubao-migrator）
                      projects_full.json   项目 + 项目内对话
                      conv_index.json      全对话索引（断点续提依据）
                      all_messages.json    全部消息（增量合并）
                      memories.json        个人记忆（需人工核对面板）
                      skills.json          技能清单
                                  │
                                  ▼
                    转换器（src/convert.py + place_to_folders.py）
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
     ~/.workbuddy/memory/    各项目文件夹/        ~/.hermes/memories/
     doubao-import_*.md      .workbuddy/memory/   MEMORY.md（追加）
     （经验记忆）              + 豆包Work资产全录   （§ 分隔，幂等替换）
                                  │
                                  ▼
                        hermes project create（10 个项目 + 目录绑定）
```

## 幂等性设计

- `convert.py` 对 Hermes MEMORY.md：检测同日期标记，存在则替换旧段而非追加
- `place_to_folders.py`：直接覆盖写入目标文件（源在中央归档，可重复跑）
- `extract_messages.js`：跳过已有消息的对话，断点续提
- 中间产物在 WORK_DIR，删了重跑即全量

## 目录放置策略

| 内容 | 位置 | 是否自动加载 |
|---|---|---|
| 9 条个人记忆 | `~/.workbuddy/memory/doubao-import_<日期>_memory.md` | 是（经验记忆） |
| 项目摘要（对话索引） | `<项目目录>/.workbuddy/memory/doubao-import_<日期>_memory.md` | 是（该项目内） |
| 完整转录（MB 级） | `<项目目录>/豆包Work资产全录_<项目>.md` | 否（按需让 AI 读） |
| Hermes 记忆 | `~/.hermes/memories/MEMORY.md` | 是（始终激活） |
| Hermes 项目 | `hermes project create <name> <folders...>` | — |
