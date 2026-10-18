# 豆包 API 协议笔记（逆向工程记录）

记录时间：2026-10-19，DoubaoWork v2.32.x（macOS），Chromium 147。

## 0. 接入方式

豆包Work 是 Chromium 套壳应用。挂 CDP：

```bash
pkill -f DoubaoWork; sleep 3
rm -f ~/Library/Application\ Support/DoubaoWork/SingletonLock ~/Library/Application\ Support/DoubaoWork/SingletonSocket
nohup /Applications/DoubaoWork.app/Contents/MacOS/DoubaoWork --remote-debugging-port=9222 >/tmp/dw.log 2>&1 &
curl -s --noproxy '*' http://127.0.0.1:9222/json/version   # 就绪
```

然后用 Node 全局 `WebSocket`（Node ≥18 自带）直连 target，或 playwright-core `connectOverCDP`。

## 1. 同源陷阱（最重要）

| 发起位置 | 结果 |
|---|---|
| `chrome://doubaowork-launcher` 页面 fetch `www.doubao.com` | 返回 SPA HTML（网关按 Origin 路由），即使 `credentials:'include'` 也没用 |
| `www.doubao.com` 同源 target 内 fetch | 正常 JSON |

可用同源 target：
- 客户端内的 drive-iframe（`/json/list` 里 `type: iframe`，URL 含 `www.doubao.com/drive-iframe/`）——会随界面重载而消失
- 自建 tab：`PUT /json/new?https://www.doubao.com/chat/`，等 `location.href` 就绪再注入 helper（响应里 target id 字段是 `id`）

## 2. 请求格式

- 方法：POST（`/samantha/skill/list` 等少数为 GET）
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
| `/alice/office/skills/list_user_and_featured` | — | 技能清单 | GET/POST 均可 |
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
- 消息字段：`user_type`（1=用户，2=豆包）、`content_type`（1=文本）、`content`（JSON 串，取 `text`）、`thinking_content`（JSON 串，取 `thinks[].text`）、`create_time`（Unix 秒）、`index_in_conv`
- 注意 `index_in_conv` 不连续（有重新生成的会话），去重按 `message_id`

## 6. CDP 稳定性

- 整对话消息一次性 `returnByValue`（可能几 MB）会压爆 WebSocket → 必须逐页拉取
- 断线后重连同一 target 即可继续（tab 不会消失；drive-iframe target 会）
- `crypto.randomUUID` 在新 tab 初始上下文不可用 → 手写 UUID

## 7. 记忆提取（无 API）

聊天页 → 左下角「设置」→「记忆 已启用」→ 打开「管理记忆」面板。条目结构 = 内容 + 日期（`YYYY/MM/DD`）。面板内滚动加载，DOM 提取：

```js
// 找日期元素，向上取最近的有内容容器
const dateRe = /^20\d{2}\/\d{2}\/\d{2}$/;
```

## 8. 本地数据位置（均已验证无明文缓存）

- `~/Library/Application Support/DoubaoWork/Default/IndexedDB/*` — 0 命中
- `~/Library/Application Support/DoubaoWork/Default/Local Storage/leveldb/` — 0 命中
- `~/Library/Application Support/DoubaoWork/Default/DoubaoStorage/Aida/` — 只有聊天图片
- `DoubaoWork.app/.../doubao_office.pak` — 全压缩，strings 无输出
