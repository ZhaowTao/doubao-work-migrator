// 审计补充 3：自造游标翻页 / 归档消息提取 / 技能全量 / 云盘 iframe 捕获
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
async function attach(wsUrl) {
  await new Promise((res, rej) => {
    ws = new WebSocket(wsUrl);
    ws.onopen = res; ws.onerror = () => rej(new Error('ws err'));
    ws.onclose = () => { for (const [, p] of pending) p.reject(new Error('CLOSED')); pending.clear(); };
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } };
  });
}
const evalJS = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
  return r.result.value;
};
const HELPERS = `
  window.__api = async function(path, body, isGet) {
    const Q = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop&aid=1044603&real_aid=1044603&pkg_type=release_version';
    const opt = { method: isGet ? 'GET' : 'POST', headers: { 'agw-js-conv': 'str', 'accept': 'application/json, text/plain, */*' } };
    if (!isGet) { opt.headers['Content-Type'] = 'application/json; encoding=utf-8'; opt.body = JSON.stringify(body); }
    const r = await fetch(path + '?' + Q, opt);
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { return { __err: txt.slice(0, 100) }; }
  };
  window.__uuid = () => { const h = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0'); return h() + h() + '-' + h() + '-4' + h().slice(1) + '-' + '89ab'[Math.floor(Math.random() * 4)] + h().slice(1) + '-' + h() + h() + h(); };
  window.__KEEP = ['message_id','user_type','content_type','content','thinking_content','create_time','index_in_conv'];
  window.__pullPage = async function(cid, ctype, anchor) {
    const body = (await window.__api('/im/chain/single', { cmd: 3100, sequence_id: window.__uuid(), channel: 2, version: '1',
      uplink_body: { pull_singe_chain_uplink_body: { conversation_id: cid, anchor_index: anchor, conversation_type: ctype || 3,
        direction: 1, limit: 50, ext: {}, filter: { index_list: [] }, evaluate_ab_params: '', evaluate_common_params: '', option: { lazy_load_strategy: 0 } } } }))?.downlink_body?.pull_singe_chain_downlink_body;
    if (!body) return { msgs: [], has_more: false };
    const msgs = (body.messages || []).map(m => { const o = {}; for (const k of window.__KEEP) if (m[k] !== undefined) o[k] = m[k]; return o; });
    let minIdx = Infinity;
    for (const m of msgs) { const i = typeof m.index_in_conv === 'number' ? m.index_in_conv : parseInt(m.index_in_conv || '0'); if (i < minIdx) minIdx = i; }
    return { msgs, has_more: !!body.has_more, minIdx: minIdx === Infinity ? null : minIdx };
  };
  'ok'
`;
(async () => {
  let list = await httpGet('/json/list');
  let t = list.filter(x => x.type === 'page' && x.url.startsWith('https://www.doubao.com')).pop();
  if (!t) { const nt = await httpGet('/json/new?https://www.doubao.com/chat/', 'PUT'); t = { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/' + (nt.id || nt.targetId) }; }
  await attach(t.webSocketDebuggerUrl);
  for (let i = 0; i < 20; i++) { const loc = await evalJS(`location.href`).catch(() => ''); if (typeof loc === 'string' && loc.startsWith('https://www.doubao.com')) break; await new Promise(r => setTimeout(r, 500)); }
  await evalJS(HELPERS);
  console.log('helpers ready');

  // 1. 自造游标：用本页最小 position_version 作为下一页 conv_version
  console.log('=== 自造游标翻页测试 ===');
  let cursor = 0; const seen = new Set();
  for (let page = 0; page < 15; page++) {
    const body = await evalJS(`
      window.__api('/im/chain/recent_conv', { cmd: 3200, sequence_id: window.__uuid(), channel: 2, version: '1',
        uplink_body: { pull_recent_conv_chain_uplink_body: {
          limit: 50, filter: { conversation_type: [], project_filter: 0, device_filter: 0 },
          message_count_per_conv: 0, api_version: 1, conv_version: ${cursor}, direction: 2,
          option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: false, need_coco_bot: false, need_pc_pin_chain: true, pc_pin_query_type: 1, exclude_archive: false, only_archive: false }
        } } }).then(r => r?.downlink_body?.pull_recent_conv_chain_downlink_body)
    `);
    if (!body) break;
    let minVer = Infinity; let added = 0;
    for (const cell of (body.cells || [])) {
      const c = cell.conversation;
      if (c && !seen.has(c.conversation_id)) { seen.add(c.conversation_id); added++; }
      const pv = parseInt(cell.position_version || '0');
      if (pv && pv < minVer) minVer = pv;
    }
    console.log('page', page, '| new', added, '| total', seen.size, '| minVer', minVer === Infinity ? 'n/a' : minVer);
    if (added === 0 || minVer === Infinity) break;
    cursor = minVer;
  }
  console.log('自造游标可达对话总数:', seen.size);

  // 2. 提取 2 个归档对话的消息并合并
  const all = JSON.parse(fs.readFileSync(OUT + '/all_messages.json', 'utf8'));
  const archivedIds = ['38439025221667586', '38439237934909186'];
  for (const cid of archivedIds) {
    if (all[cid] && (all[cid].messages || []).length) { console.log('归档', cid, '已有'); continue; }
    let anchor = 9007199254740991; const seenM = new Set(); const msgs = [];
    for (let p = 0; p < 60; p++) {
      const r = await evalJS(`window.__pullPage('${cid}', 3, ${anchor})`);
      if (!r || !r.msgs || !r.msgs.length) break;
      let added = 0;
      for (const m of r.msgs) if (!seenM.has(m.message_id)) { seenM.add(m.message_id); msgs.push(m); added++; }
      if (!r.has_more || added === 0) break;
      anchor = (r.minIdx === null ? 0 : r.minIdx) - 1;
      if (anchor < 0) break;
    }
    all[cid] = { name: '(已归档)', project: '(已归档)', messages: msgs };
    console.log('归档对话', cid, '消息数:', msgs.length);
  }
  fs.writeFileSync(OUT + '/all_messages.json', JSON.stringify(all, null, 1));
  console.log('合并后对话总数:', Object.keys(all).length, '消息总数:', Object.values(all).reduce((a, v) => a + (v.messages || []).length, 0));

  // 3. 技能全量保存
  const skills = await evalJS(`window.__api('/alice/office/skills/list_user_and_featured', { cmd: 1, sequence_id: window.__uuid() }).then(r => r?.data?.skills || [])`);
  fs.writeFileSync(OUT + '/skills.json', JSON.stringify(skills, null, 1));
  console.log('技能数:', skills.length);
  skills.forEach(s => console.log('  -', s.show_name || s.name));
  ws.close();
})().catch(e => { console.error('FATAL', e.message); try { ws && ws.close(); } catch (_) {} process.exit(1); });
