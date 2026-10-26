# 豆包 API 协议笔记（逆向工程记录）

记录时间：2026-10-19 首版，2026-10-26 修订（v2.32.14）。DoubaoWork v2.32.x（macOS），Chromium 147。

## 0. 接入方式

豆包Work 是 Chromium 套壳应用。挂 CDP：

```bash
pkill -f "/Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork"   # 必须精确路径，宽匹配会误杀其他进程
sleep 3
rm -f ~/Library/Application\ Support/DoubaoWork/SingletonLock ~/Library/Application\ Support/DoubaoWork/SingletonSocket
nohup /Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork --remote-debugging-port=9222 >"$HOME/.doubao-migrator/logs/dw.log" 2>&1 &
curl -s --noproxy '*' http://127.0.0.1:9222/json/version   # 就绪
```

坑位清单（都是实测踩到的）：

- 中间产物不要放 `/tmp`：macOS 会清理，几天后整条链路失效。用 `~/.doubao-migrator`
- `open -a App --args ...` 在已有实例残留时会**吞掉参数**；必须先把进程杀干净 + 清 SingletonLock，再 `nohup` 起二进制
- 本机若开了 HTTP 代理，`curl 127.0.0.1:9222` 会返回 502 → 用 `--noproxy '*'`
- 在受沙箱限制的环境里，`pkill` 可能被静默拦截，脚本结束时调试端口仍在 → 脚本要自检并提示手动清理

然后用 Node 全局 `WebSocket`（Node ≥18 自带）直连 target，或 playwright-core `connectOverCDP`。

## 1. 同源陷阱（最重要）

| 发起位置 | 结果 |
|---|---|
| `chrome://doubaowork-launcher` 页面 `fetch('www.doubao.com/...')` | 返回 SPA HTML（网关按 Origin 路由），即使 `credentials:'include'` 也没用 |
| `www.doubao.com` 同源 target 内 `fetch` | 正常 JSON |
| **App 内页面（`chrome://doubaowork-chat/chat`）用 XHR + 绝对 URL** | **正常 JSON**（Cookie 随请求走，可直连记忆接口） |

关键：App 内页面用**相对路径**会被自定义协议接管（`/chat/memory/list` 被解析成 `chrome://doubaowork-chat/chat/memory/list`，返回 SPA HTML）。必须写全 `https://www.doubao.com/...` 并 `withCredentials = true`。

可用同源 target：
- 客户端内的 drive-iframe（`/json/list` 里 `type: iframe`，URL 含 `www.doubao.com/drive-iframe/`）——会随界面重载而消失
- 自建 tab：`PUT /json/new?https://www.doubao.com/chat/`，等 `location.href` 就绪再注入 helper（响应里 target id 字段是 `id`）

## 2. 请求格式

- 方法：POST（**注意 API 会漂移**：`/samantha/skill/list` 在 10-19 是 GET，10-26 已改成只有 POST 才返回，GET 直接 404）
- 头：`agw-js-conv: str`、`content-type: application/json; encoding=utf-8`、`accept: application/json, text/plain, */*`
- query：`version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop&aid=1044603&real_aid=1044603&pkg_type=release_version`
- 信封体：
```json
{"cmd": <int>, "sequence_id": "<uuid>", "channel": 2, "version": "1", "uplink_body": {<具体业务体>}}
```
- 响应：`{"cmd": <同cmd>, "downlink_body": {<业务体>}, "status_code": 0}`

## 3. 端点清单

| 端点 | cmd | 用途 | 备注 |
|---|---|---|---|
| `/im/project/list` | 4605 | 项目列表 + 每项目对话 | `limit:100, include_invisible_projects:true`；**项目对话的权威全量来源** |
| `/im/chain/recent_conv` | 3200 | 会话列表 | 翻页游标损坏（见 §4）；`only_archive:true` 取归档 |
| `/im/chain/single` | 3100 | 单对话消息 | `anchor_index` 翻页，见 §5 |
| `/chat/memory/list` | — | **个人记忆清单** | POST，体 `{"bot_id":"<19位id>"}`，见 §7 |
| `/samantha/skill/list` | — | 技能清单 | **必须 POST**（GET 404）；返回 `skills/input_skill/sidebar_skill/recommend_skill` 多组 |
| `/alice/user/config/pull` | — | 用户配置 | GET，打开设置面板时自动发出 |
| `/alice/office/skills/list_user_and_featured` | — | 技能清单（旧路径） | 仍在，但与 `/samantha/skill/list` 结果不完全一致 |
| `/alice/office/skills/connector/list_by_user` | — | 连接器清单 | 本机为空 |
| `/alice/office/skills/plugin/list_by_user` | — | 插件清单 | 返回 permission denied |

## 4. recent_conv 翻页游标缺陷

`uplink_body.pull_recent_conv_chain_uplink_body`：

```json
{"limit":50,"filter":{"conversation_type":[],"project_filter":0,"device_filter":0},
 "message_count_per_conv":0,"api_version":1,"conv_version":<游标>,"direction":3,
 "option":{"not_need_message":true,"need_complete_conversation":true,
           "need_pc_pin_chain":true,"pc_pin_query_type":1,
           "exclude_archive":false,"only_archive":false}}
```

实测：无论用响应里的 `next_conv_version` 还是 cell 的 `position_version` 作下一页游标，**都返回同一页 50 条**。结论：该端点只能取最近 50 条；更早的对话只能通过项目列表覆盖。做全量备份时以项目列表为准，recent_conv 仅用于补非项目对话。

## 5. chain/single 消息翻页

```json
{"conversation_id":"<id>","anchor_index":9007199254740991,"conversation_type":3,
 "direction":1,"limit":50,"ext":{},"filter":{"index_list":[]},
 "evaluate_ab_params":"","evaluate_common_params":"","option":{"lazy_load_strategy":0}}
```

- `anchor_index: 9007199254740991`（2^53-1）= 从最新开始
- `direction: 1` = 向更早翻
- 每页返回后，取本页最小 `index_in_conv - 1` 作为下一页 anchor，直到 `has_more: false`
- 消息字段：`user_type`（1=用户，2=豆包）、`content_type`（1=文本，20=图片/附件）、`content`（JSON 串）、`thinking_content`（JSON 串，取 `thinks[].text`）、`create_time`（Unix 秒）、`index_in_conv`
- **`content_type: 20` 的正文在 `content.entities[]` 里**，只取 `content.text` 会把整条图片消息丢掉。图片地址：`entities[].entity_content.image.image_ori.url`（带签名，`x-expires` 到 2109 年，长期可用）；文件地址：`entity_content.file`
- `content_block` 存在但只含排版块，图片信息不在这里
- 注意 `index_in_conv` 不连续（有重新生成的会话），去重按 `message_id`

## 5.1 增量判据

会话对象（项目列表 / recent_conv 里都有）带 `update_time`（毫秒字符串）。本地缓存每条对话同时存下 `update_time`，下次同步只重拉「`update_time` 变新」的对话，并按 `message_id` 合并新旧消息，避免重复拉全量。

## 6. CDP 稳定性

- 整对话消息一次性 `returnByValue`（可能几 MB）会压爆 WebSocket → 必须逐页拉取
- 断线后重连同一 target 即可继续（tab 不会消失；drive-iframe target 会）
- `crypto.randomUUID` 在新 tab 初始上下文不可用 → 手写 UUID

## 7. 记忆提取（有 API，别再抠 DOM）

`POST https://www.doubao.com/chat/memory/list?<通用 query>`
头：`Accept: application/json, text/plain, */*`、`Content-Type: application/json`、`Agw-Js-Conv: str`
体：`{"bot_id": "7338286299411103781"}`（主账号 bot，可在 `~/.doubao-migrator/config.json` 缓存）

响应：

```json
{"data": {"agent_soul": [],
          "saved_memory": [{"content": "...", "date": "2026/10/25", "id": "<sha-like>"}]},
 "code": 0}
```

- `saved_memory` = 「管理记忆」面板里的用户主动记忆，**一次全量返回，无分页**
- `agent_soul` = 人格/伙伴层记忆，主账号为空；自定义「伙伴」可能各有一份（未验证，需按 bot_id 逐个查）
- 每条带稳定 `id` → 可做增删对比（本次同步新增/消失了哪几条）
- 早期版本的 DOM 抠取法（点设置 → 记忆面板 → 按日期正则抓容器）**会漏条目**：同一批数据 API 返回 16 条，DOM 只抓到 9 条。已废弃

bot_id 自动发现：挂 XHR hook → 点左下角「设置」→ 点「记忆」行 → 读取请求体里的 `bot_id`，缓存进 config。

## 8. 本地数据位置（均已验证无明文缓存）

- `~/Library/Application Support/DoubaoWork/Default/IndexedDB/*` — 0 命中
- `~/Library/Application Support/DoubaoWork/Default/Local Storage/leveldb/` — 0 命中
- `~/Library/Application Support/DoubaoWork/Default/DoubaoStorage/Aida/` — 只有聊天图片
- `DoubaoWork.app/.../doubao_office.pak` — 全压缩，strings 无输出

结论：记忆、项目、对话都是**纯云端**数据，只能走接口。

## 9. 尚未解决（2026-10-26）

| 项 | 状态 | 说明 |
|---|---|---|
| 云盘文件 | ❌ | 猜过的端点全 404；用 CDP 派发鼠标事件点「云盘」不触发导航（React 需要真实手势），要抓需人工点一次再挂 hook |
| 伙伴(bot) 列表 | ❌ | 枚举接口未知，因此无法逐个 bot 查 `agent_soul` |
| 其他设备的老对话 | ❌ | `recent_conv` 游标缺陷（§4），非项目对话只能拿到最近 50 条 |
| 记忆去重 | ⚠ | 豆包自身不做去重，会出现同义条目（如 3 条「不用破折号和双引号」）。工具只做相似度提示，合并需人工 |
| 消息内图片本体 | ⚠ | 只保留签名 URL（有效期到 2109），未下载到本地；离线或 URL 失效后不可读 |
