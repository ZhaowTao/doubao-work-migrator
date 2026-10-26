# doubao-work-migrator

**把豆包 Work（DoubaoWork 桌面客户端）的个人记忆、项目和全部对话历史，提取并迁移到 WorkBuddy 和 Hermes。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

## 为什么做这个项目

豆包 Work 的**记忆和项目是纯云端功能**：本地 IndexedDB、Local Storage、DoubaoStorage 全部扫过，0 条明文缓存；官方只提供「单条会话转文档」，没有全量导出，更没有记忆导出。

现成的开源导出工具（doubao-helper、MemorySeek、doubao-rescue 等）都面向**豆包网页版**，只做「导出成 Markdown/JSON」。这个项目做的是另一层：

- ✅ 驱动**已登录的桌面客户端**（Chromium 套壳，挂 CDP），登录态原样复用，不用扫码
- ✅ 提取**个人记忆**（走 `/chat/memory/list` 接口，结构化 JSON，可做增删对比）
- ✅ **项目结构化提取**（项目 + 每个项目绑定的本地目录）
- ✅ **跨产品导入**：WorkBuddy 经验记忆 + 项目内记忆 + Hermes `MEMORY.md` + Hermes projects
- ✅ **真增量**：按会话 `update_time` 判断，只拉变化的对话，新旧消息按 `message_id` 合并
- ✅ 消息里的**图片与文件**保留为 Markdown 链接（不再整条丢弃）

## 工作原理

下图里的路径都是默认值，括号内是可用环境变量覆盖的项。

```
豆包Work 桌面客户端（已登录）
   │  ① 精确 pkill + 清 SingletonLock + --remote-debugging-port=9222 重启
   │  ② App 内页面用绝对 URL 发 XHR（相对路径会被自定义协议吃掉）
   ▼
豆包 API
   ├── /im/project/list        项目 + 项目内对话（权威全量）
   ├── /im/chain/recent_conv   最近 50 条 + 归档对话
   ├── /im/chain/single        单对话全部消息（anchor 翻页）
   ├── /chat/memory/list       个人记忆（POST {bot_id}）
   └── /samantha/skill/list    技能清单（POST）
   ▼
~/.doubao-migrator/export/   中间产物（JSON，可断点续提，DOUBAO_WORK_DIR）
   ▼
转换器
   ├── ~/.workbuddy/memory/doubao-import_memory.md      WorkBuddy 经验记忆（WORKBUDDY_MEM_FILE）
   ├── <项目目录>/.workbuddy/memory/doubao-work-sync_memory.md   项目摘要（自动注入）
   ├── <项目目录>/豆包Work资产全录_<项目>.md                      完整转录
   └── ~/.hermes/memories/MEMORY.md                     Hermes 常驻记忆（HERMES_MEM_FILE）
```

## 适用环境

| 项 | 要求 |
| --- | --- |
| 系统 | macOS（脚本用 LaunchServices + `pkill` 启动和恢复客户端，Linux/Windows 需自行改 `bin/sync.sh`） |
| 豆包 Work | 桌面客户端 v2.32.x（Chromium 147）实测可用；更低版本未验证，接口可能不同 |
| Node | ≥ 18（依赖内置 `WebSocket`，不需要 `ws` 包） |
| Python | 3.8+（只用标准库，无第三方依赖） |
| 登录态 | 客户端已登录且能正常打开记忆面板 |

接口是抓包逆出来的非公开协议，豆包每次客户端升级都有可能改。如果某一步静默返回空数据，先看 `docs/api-notes.md` 里记的协议，再用 CDP 重新抓一次比对。

## 快速开始

```bash
git clone https://github.com/ZhaowTao/doubao-work-migrator.git
cd doubao-work-migrator
./bin/sync.sh          # 首次全量，之后每次只拉增量
./bin/sync.sh --full   # 忽略缓存，全量重拉
```

脚本会自动做的事：精确杀掉客户端 → 清 `SingletonLock` → 以 `--remote-debugging-port=9222` 重启 → 跑完七个步骤 → 恢复客户端。**你不需要手动开调试端口**，也不需要改任何文件。

### 可配置项

全部走环境变量，不设就用默认值：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DOUBAO_OUT_DIR` | `~/WorkBuddy/豆包Work导入` | Markdown 归档根目录（总览 + 分项目转录） |
| `DOUBAO_WORK_DIR` | `~/.doubao-migrator` | 中间产物与增量缓存目录 |
| `DOUBAO_APP` | `/Applications/DoubaoWork.app` | 客户端路径 |
| `WORKBUDDY_MEM_FILE` | `~/.workbuddy/memory/doubao-import_memory.md` | WorkBuddy 经验记忆落点 |
| `HERMES_MEM_FILE` | `~/.hermes/memories/MEMORY.md` | Hermes 常驻记忆落点 |

例：只想拿 Markdown、不碰任何 agent 的记忆文件

```bash
DOUBAO_OUT_DIR=~/doubao-export ./bin/sync.sh
```

后两个目标工具的父目录不存在时会自动跳过并打印提示，不会给你造一堆空目录。两个变量都支持 `~` 展开，空字符串视为未设置。

## 目录结构

```
src/
  lib/cdp.js            零依赖 CDP 客户端（Node 自带 WebSocket）
  refresh_index.js      刷新对话索引（项目 + 最近 50 + 归档，含 update_time）
  extract_messages.js   增量提取消息（update_time 判据 + message_id 合并 + 断线重连）
  extract_memories.js   个人记忆（API 驱动 + bot_id 自动发现 + 增删对比）
  extract_skills.js     技能清单（POST，多分组合并去重）
  convert.py            生成归档与两边记忆（幂等）
  place_to_folders.py   项目资产落到各自本地文件夹（旧文件自动归档）
bin/sync.sh             一键同步入口
docs/
  api-notes.md          豆包 API 协议笔记与踩坑记录
  architecture.md       架构与数据流详解
```

## 关键技术点（都是踩出来的）

1. **同源限制**：从 `chrome://doubaowork-launcher` 页面 fetch `www.doubao.com` 的 API 会被网关按 Origin 路由回 SPA HTML（带 cookie 也无用）。可用 www.doubao.com 同源 target，或**在 App 内页面用 XHR + 绝对 URL**（后者连记忆接口也能打通）。
2. **相对路径陷阱**：App 内页面写 `/chat/memory/list` 会被解析成 `chrome://doubaowork-chat/chat/memory/list`，返回 SPA HTML。必须写全 `https://www.doubao.com/...` 且 `withCredentials = true`。
3. **API 会漂移**：`/samantha/skill/list` 首版是 GET，后来 GET 404、POST 才有数据。写死方法会静默失效。
4. **消息翻页**：`/im/chain/single` 用 `anchor_index: 2^53-1, direction: 1` 从最新往回拉，取本页最小 `index_in_conv - 1` 续拉。
5. **大 payload 压爆 CDP WebSocket**：整对话一次性 `returnByValue` 必断连，必须逐页（≤50 条）+ 断线重连。
6. **`content_type: 20` 是图片/附件**：正文在 `content.entities[]`，只读 `content.text` 会把整条消息丢掉。
7. **会话列表翻页游标是坏的**：`next_conv_version` / `position_version` 都返回同一页，`recent_conv` 只能拿最近 50 条，项目对话以 `/im/project/list` 为权威。
8. **中间产物别放 `/tmp`**：macOS 会清理，几天后链路直接失效（这个坑把 v1.0 的同步脚本废掉了）。
9. **`pkill -f "DoubaoWork"` 太宽**：会误杀命令行里带该字符串的其他进程（实测把自己的 shell 杀了）。用完整二进制路径。
10. **`open -a --args` 会吞参数**：已有实例残留时新参数不生效，必须杀掉+清 SingletonLock 再 `nohup`。
11. **本机代理拦 localhost**：`curl 127.0.0.1:9222` 要 `--noproxy '*'`。

## 已知边界

| 项 | 状态 |
|---|---|
| 云盘文件 | ❌ 无接口；CDP 合成鼠标事件点「云盘」不触发导航（需真实手势），要抓得人工点一次再挂 hook |
| 伙伴(bot) 独立记忆 | ❌ 枚举接口未知，`agent_soul` 只验证了主账号为空 |
| 其他设备的老对话 | ❌ 受 `recent_conv` 游标缺陷限制 |
| 记忆去重 | ⚠ 豆包自身不去重，会累积同义条目；工具只做相似度提示，合并需人工 |
| 图片本体 | ⚠ 只存签名 URL（有效期到 2109），未下载到本地 |

## 免责声明

- 仅用于导出**用户本人**在已登录客户端中的数据。全部在本地处理，不上传任何服务器，不联网除豆包自身接口外。
- 用的是**非公开接口**，被抓包逆出来的，随时可能随客户端升级失效。失效不是 bug，是预期内的事。
- 自动化操作会重启客户端、挂 CDP 调试端口。请自行评估账号风险，包括但不限于服务条款对自动化访问的限制。
- **不要**用它批量抓取他人数据、共享账号或绕过登录。
- 导出的 Markdown 与 JSON 里是完整对话正文，属于个人数据。开源仓库里不要提交 `export/`、`*.jsonl`、`config.json`（`.gitignore` 已挡）。
- 作者不对使用本工具导致的账号处罚、数据丢失或任何间接损失负责。

## 署名

如果这个工具帮你省了事，转载或二次开发时留个仓库链接就行，不用打招呼。

## License

MIT
