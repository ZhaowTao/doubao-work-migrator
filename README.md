# doubao-work-migrator

**把豆包 Work（DoubaoWork 桌面客户端）的个人记忆、项目和全部对话历史，提取并迁移到 WorkBuddy 和 Hermes。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

## 为什么做这个项目

豆包 Work 的**记忆和项目是云端功能**，本地无明文缓存，官方也没有导出通道。现有的开源导出工具（doubao-helper、MemorySeek、doubao-rescue 等）都面向**豆包网页版**，且只做「导出成 Markdown/JSON」，没有一个能做到：

- ✅ 驱动**已登录的豆包 Work 桌面客户端**（Chromium 套壳，挂 CDP 即可）
- ✅ 提取**个人记忆面板**（设置 → 记忆，无 API，DOM 提取）
- ✅ **项目结构化提取**（10 个项目 + 本地目录映射）
- ✅ **跨产品导入**：转成 WorkBuddy 记忆文件 + Hermes `MEMORY.md` + Hermes projects
- ✅ **增量同步**：一条命令只拉新对话

## 工作原理

```
豆包Work 桌面客户端（已登录）
   │  ① pkill 后带 --remote-debugging-port=9222 重启
   │  ② 从 www.doubao.com 同源 target 发请求（关键！见 docs/api-notes.md）
   ▼
豆包开放 API（cmd 信封协议）
   ├── /im/project/list            项目 + 项目内对话（权威全量）
   ├── /im/chain/recent_conv       最近 50 条 + 归档对话
   ├── /im/chain/single            单个对话的全部消息（anchor 翻页）
   └── /alice/office/skills/...    技能清单
   ▼
本地 JSON 中间产物（可断点续提）
   ▼
转换器
   ├── ~/.workbuddy/memory/doubao-import_<日期>_memory.md    WorkBuddy 经验记忆
   ├── <项目目录>/.workbuddy/memory/doubao-import_*.md       项目摘要（自动注入）
   ├── <项目目录>/豆包Work资产全录_<项目>.md                  完整转录
   └── ~/.hermes/memories/MEMORY.md                          Hermes 常驻记忆
```

## 快速开始

```bash
# 一键增量同步（自动处理 App 重启、索引刷新、增量提取、格式转换、放置）
~/doubao-work-migrator/bin/sync.sh
```

首次运行会做全量提取；之后每次运行只拉取新增/更新的对话。

> 豆包的**个人记忆增删**不在 API 内，需在「设置 → 记忆」面板人工核对（脚本会提示）。

## 目录结构

```
src/
  refresh_index.js     刷新对话索引（项目 + 最近 50 + 归档）
  extract_messages.js  增量提取消息（逐页拉取 + 断点重连续提）
  convert.py           生成 WorkBuddy/Hermes 格式（幂等）
  place_to_folders.py  把项目资产放置到各自本地文件夹
  audit.js             完整度审计（覆盖了什么、漏了什么）
  extract_archived.js  归档对话补提
bin/sync.sh            一键同步入口
docs/
  api-notes.md         豆包 API 协议笔记与踩坑记录
  architecture.md      架构与数据流详解
```

## 关键技术点（都是坑）

1. **同源限制**：从 `chrome://doubaowork-launcher` 页面 fetch `www.doubao.com` 的 API，会被网关按 Origin 路由回 SPA HTML（即使带 cookie）。必须从 **www.doubao.com 同源 target** 发请求——用 drive-iframe target 或自建 tab（`PUT /json/new?https://www.doubao.com/chat/`）。
2. **API 协议**：POST + `agw-js-conv: str` 头 + `{cmd, sequence_id, channel:2, version:'1', uplink_body}` 信封体。
3. **消息翻页**：`/im/chain/single` 用 `anchor_index: 9007199254740991, direction: 1` 从最新往回拉，按返回的最小 `index_in_conv - 1` 继续。
4. **大 payload 会压爆 CDP WebSocket**：整对话一次性 `returnByValue` 必断连，必须逐页拉取（每页 ≤50 条）+ 断线重连。
5. **会话列表翻页游标是坏的**：`next_conv_version` 和 `position_version` 作游标都返回同一页——`recent_conv` 只能拿最近 50 条。项目对话必须以 `/im/project/list` 为权威来源。
6. **新 tab 里 `crypto.randomUUID` 不可用**（初始上下文非安全上下文），需手写 UUID。
7. **macOS 没有 `setsid`**；`open -a --args` 在已有实例时会吞参数——直接 `nohup <二进制> --flag &` 最稳。
8. **本机代理会拦截 localhost**：curl 访问 `127.0.0.1:9222` 要加 `--noproxy '*'`。

## 已知边界

- 云盘文件：豆包云盘无本地缓存、导出接口未开放，**未覆盖**。
- 仅存在于其他设备的老对话：受 `recent_conv` 游标缺陷限制，**无法触及**。
- 个人记忆：面板提取是完整的，但增删同步需人工核对。

## 免责声明

本项目仅用于导出**用户本人**在已登录客户端中的数据，全部处理在本地完成，不上传任何服务器。豆包 API 为非公开接口，可能随版本变化而失效。

## License

MIT
