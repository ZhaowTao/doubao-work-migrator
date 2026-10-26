# 架构与数据流

## 数据流

```
豆包Work 客户端 ──CDP(9222)──▶ Node 脚本（src/*.js）
                                  │ App 内页面 XHR + 绝对 URL
                                  ▼
                              豆包 API
                                  │
                                  ▼
                    中间产物（WORK_DIR，默认 ~/.doubao-migrator/export）
                      projects_full.json   项目 + 项目内对话
                      conv_index.json      全对话索引（含 update_time）
                      all_messages.json    全部消息（按 update_time 增量、message_id 合并）
                      memories.json        个人记忆（API 直取，含稳定 id）
                      memories_meta.json   本次抓取元信息（增删对比）
                      skills.json          技能清单
                                  │
                                  ▼
                    转换器（src/convert.py + place_to_folders.py）
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
     ~/.workbuddy/memory/    各项目文件夹/        ~/.hermes/memories/
     doubao-import_memory.md .workbuddy/memory/   MEMORY.md
     （经验记忆，覆盖写）      + 豆包Work资产全录   （标记段替换）
                                  │
                                  ▼
                        hermes project create（项目 + 目录绑定）
```

## 幂等性设计

- **文件名稳定**：记忆类文件不再按日期命名，避免每次同步堆出多份近似记忆被同时注入上下文；旧版按日期命名的文件自动移到 `_archive/`
- `convert.py` 对 Hermes MEMORY.md：用固定标记段（`【豆包Work 记忆同步】`）做整段替换，不追加；兼容清理旧版按日期的标记段
- `place_to_folders.py`：目标文件直接覆盖（源在中央归档，可重复跑）
- `extract_messages.js`：按 `update_time` 判断是否重拉，新旧消息按 `message_id` 合并去重
- `extract_memories.js`：与上次 `memories.json` 比对，输出新增 / 消失条目
- 中间产物在 WORK_DIR；删掉即全量重跑，不会污染源数据

## 目录放置策略

| 内容 | 位置 | 是否自动加载 |
|---|---|---|
| 个人记忆（全部） | `~/.workbuddy/memory/doubao-import_memory.md` | 是（经验记忆） |
| 项目摘要（对话索引） | `<项目目录>/.workbuddy/memory/doubao-work-sync_memory.md` | 是（该项目内） |
| 完整转录（MB 级） | `<项目目录>/豆包Work资产全录_<项目>.md` | 否（按需让 AI 读） |
| Hermes 记忆 | `~/.hermes/memories/MEMORY.md` | 是（始终激活） |
| Hermes 项目 | `hermes project create <name> <folders...>` | — |

设计原则：**小的自动加载，大的按需读取**。摘要给出「有什么对话」的索引，全录保存原文，避免 MB 级内容撑爆上下文窗口。
