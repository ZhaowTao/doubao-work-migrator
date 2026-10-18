// 刷新对话索引：项目列表 + 最近 50 + 归档，合并进 conv_index.json（增量同步第一步）
const CDP_HTTP = 'http://127.0.0.1:9222';
const fs = require('fs');
const OUT = '/tmp/mda/doubao_export';
let ws = null; let msgId = 0; const pending = new Map();
const httpGet = (path, method) => new Promise((res, rej) => {
  require('http').request(CDP_HTTP + path, { method: method || 'GET' }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ __raw: d.slice(0, 80) }); } }); }).on('error', rej).end();
});
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
(async () => {
  let list = await httpGet('/json/list');
  let t = list.filter(x => x.type === 'page' && x.url.startsWith('https://www.doubao.com')).pop();
  if (!t) { const nt = await httpGet('/json/new?https://www.doubao.com/chat/', 'PUT'); t = { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/' + (nt.id || nt.targetId) }; }
  await new Promise((res, rej) => {
    ws = new WebSocket(t.webSocketDebuggerUrl);
    ws.onopen = res; ws.onerror = () => rej(new Error('ws err'));
    ws.onclose = () => { for (const [, p] of pending) p.reject(new Error('CLOSED')); pending.clear(); };
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  });
  const evalJS = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result.value;
  };
  for (let i = 0; i < 20; i++) { const loc = await evalJS(`location.href`).catch(() => ''); if (typeof loc === 'string' && loc.startsWith('https://www.doubao.com')) break; await new Promise(r => setTimeout(r, 500)); }
  await evalJS(`
    window.__api = async function(path, body, isGet) {
      const Q = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop&aid=1044603&real_aid=1044603&pkg_type=release_version';
      const opt = { method: isGet ? 'GET' : 'POST', headers: { 'agw-js-conv': 'str', 'accept': 'application/json, text/plain, */*' } };
      if (!isGet) { opt.headers['Content-Type'] = 'application/json; encoding=utf-8'; opt.body = JSON.stringify(body); }
      const r = await fetch(path + '?' + Q, opt);
      const txt = await r.text();
      try { return JSON.parse(txt); } catch (e) { return { __err: txt.slice(0, 100) }; }
    };
    window.__uuid = () => { const h = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0'); return h() + h() + '-' + h() + '-4' + h().slice(1) + '-' + '89ab'[Math.floor(Math.random() * 4)] + h().slice(1) + '-' + h() + h() + h(); };
    'ok'
  `);

  // 项目列表
  const projects = await evalJS(`
    window.__api('/im/project/list', { cmd: 4605, sequence_id: window.__uuid(), channel: 2, version: '1',
      uplink_body: { list_projects_uplink_body: { limit: 100, include_invisible_projects: true, sort_type: 1, group_conversation_filter_param: { exclude_archive: false } } } })
      .then(r => r?.downlink_body?.list_projects_downlink_body?.projects || [])
  `);
  fs.writeFileSync(OUT + '/projects_full.json', JSON.stringify(projects, null, 1));

  // 最近 50 + 归档
  const recent = await evalJS(`
    window.__api('/im/chain/recent_conv', { cmd: 3200, sequence_id: window.__uuid(), channel: 2, version: '1',
      uplink_body: { pull_recent_conv_chain_uplink_body: {
        limit: 50, filter: { conversation_type: [], project_filter: 0, device_filter: 0 },
        message_count_per_conv: 0, api_version: 1, conv_version: 0, direction: 3,
        option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: false, need_coco_bot: false, need_pc_pin_chain: true, pc_pin_query_type: 1, exclude_archive: false, only_archive: false }
      } } }).then(r => r?.downlink_body?.pull_recent_conv_chain_downlink_body?.cells || [])
  `);
  const archived = await evalJS(`
    window.__api('/im/chain/recent_conv', { cmd: 3200, sequence_id: window.__uuid(), channel: 2, version: '1',
      uplink_body: { pull_recent_conv_chain_uplink_body: {
        limit: 50, filter: { conversation_type: [], project_filter: 0, device_filter: 0 },
        message_count_per_conv: 0, api_version: 1, conv_version: 0, direction: 3,
        option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: false, need_coco_bot: false, need_pc_pin_chain: true, pc_pin_query_type: 1, exclude_archive: false, only_archive: true }
      } } }).then(r => r?.downlink_body?.pull_recent_conv_chain_downlink_body?.cells || [])
  `);

  // 合并进 conv_index.json
  const oldIndex = fs.existsSync(OUT + '/conv_index.json') ? JSON.parse(fs.readFileSync(OUT + '/conv_index.json', 'utf8')) : [];
  const uniq = new Map(oldIndex.map(c => [c.id, c]));
  let added = 0;
  for (const p of projects) for (const c of (p.conversations || [])) {
    if (!uniq.has(c.conversation_id)) { uniq.set(c.conversation_id, { id: c.conversation_id, name: c.conversation_name, project: p.name }); added++; }
  }
  for (const cell of [...recent, ...archived]) {
    const c = cell.conversation;
    if (c && !uniq.has(c.conversation_id)) {
      const inProj = projects.some(p => (p.conversations || []).some(x => x.conversation_id === c.conversation_id));
      if (!inProj) { uniq.set(c.conversation_id, { id: c.conversation_id, name: c.conversation_name || '', project: archived.includes(cell) ? '(已归档)' : '(未分组)' }); added++; }
    }
  }
  fs.writeFileSync(OUT + '/conv_index.json', JSON.stringify([...uniq.values()], null, 1));
  console.log('项目', projects.length, '| 索引总数', uniq.size, '| 新增', added);
  ws.close();
})().catch(e => { console.error('FATAL', e.message); try { ws && ws.close(); } catch (_) {} process.exit(1); });
