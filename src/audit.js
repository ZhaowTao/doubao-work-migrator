// 完整度审计：归档对话 / 全量活跃对话 / 技能列表 / 云盘
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
  // 复用或新建 doubao tab
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
  for (let i = 0; i < 20; i++) {
    const loc = await evalJS(`location.href`).catch(() => '');
    if (typeof loc === 'string' && loc.startsWith('https://www.doubao.com')) break;
    await new Promise(r => setTimeout(r, 500));
  }
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
  console.log('helpers ready');

  // 1. 项目列表刷新
  const projects = await evalJS(`
    window.__api('/im/project/list', { cmd: 4605, sequence_id: window.__uuid(), channel: 2, version: '1',
      uplink_body: { list_projects_uplink_body: { limit: 100, include_invisible_projects: true, sort_type: 1, group_conversation_filter_param: { exclude_archive: false } } } })
      .then(r => r?.downlink_body?.list_projects_downlink_body?.projects || [])
  `);
  fs.writeFileSync(OUT + '/projects_full.json', JSON.stringify(projects, null, 1));
  const projConvIds = new Set();
  for (const p of projects) for (const c of (p.conversations || [])) projConvIds.add(c.conversation_id);
  console.log('项目:', projects.length, '| 项目内对话:', projConvIds.size);

  // 2. 全量对话（活跃 + 归档），去重
  async function pullAll(onlyArchive) {
    let convVersion = 0; const all = []; const seen = new Set();
    for (let page = 0; page < 60; page++) {
      const body = await evalJS(`
        window.__api('/im/chain/recent_conv', { cmd: 3200, sequence_id: window.__uuid(), channel: 2, version: '1',
          uplink_body: { pull_recent_conv_chain_uplink_body: {
            limit: 50, filter: { conversation_type: [], project_filter: 0, device_filter: 0 },
            message_count_per_conv: 0, api_version: 1, conv_version: ${convVersion}, direction: 3,
            option: { not_need_message: true, need_complete_conversation: true, need_coco_conversation: false, need_coco_bot: false, need_pc_pin_chain: true, pc_pin_query_type: 1, exclude_archive: false, only_archive: ${onlyArchive} }
          } } }).then(r => r?.downlink_body?.pull_recent_conv_chain_downlink_body)
      `);
      if (!body) break;
      for (const cell of (body.cells || [])) {
        const c = cell.conversation;
        if (c && !seen.has(c.conversation_id)) { seen.add(c.conversation_id); all.push(c); }
      }
      if (!body.has_more) break;
      convVersion = body.next_conv_version;
      if (!convVersion) break;
    }
    return all;
  }
  const active = await pullAll(false);
  console.log('活跃对话（含归档标记，全设备去重）:', active.length);
  const archived = await pullAll(true);
  console.log('归档对话:', archived.length);
  fs.writeFileSync(OUT + '/all_conv_list.json', JSON.stringify({ active, archived }, null, 1));

  // 3. 已有 vs 新增
  let have = {};
  if (fs.existsSync(OUT + '/all_messages.json')) { try { have = JSON.parse(fs.readFileSync(OUT + '/all_messages.json', 'utf8')); } catch (_) {} }
  const allKnown = new Set([...projConvIds, ...Object.keys(have)]);
  const newActive = active.filter(c => !projConvIds.has(c.conversation_id) && !have[c.conversation_id]);
  const newArchived = archived.filter(c => !projConvIds.has(c.conversation_id) && !have[c.conversation_id]);
  console.log('未提取的活跃对话:', newActive.length, '| 未提取的归档对话:', newArchived.length);
  fs.writeFileSync(OUT + '/new_convs.json', JSON.stringify({ newActive, newArchived }, null, 1));

  // 4. 技能列表
  const skills = await evalJS(`window.__api('/samantha/skill/list', null, true).then(r => r?.data?.skills || [])`);
  console.log('技能数:', skills.length);
  fs.writeFileSync(OUT + '/skills.json', JSON.stringify(skills, null, 1));
  skills.slice(0, 12).forEach(s => console.log('  -', s.show_name || s.name, '|', (s.description || '').slice(0, 40)));

  // 5. 云盘：导航到云盘页抓 API
  await evalJS(`location.href = 'https://www.doubao.com/drive/'`).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));
  const driveApis = [];
  const onRes = async (res) => {
    try {
      const u = res.url();
      if (u.includes('www.doubao.com') && /\/(drive|alice|samantha|space)/.test(u) && (res.headers()['content-type'] || '').includes('json')) {
        driveApis.push({ url: u.split('?')[0], body: (await res.text()).slice(0, 600) });
      }
    } catch (e) {}
  };
  // CDP Network 方式太重，改用页面内 fetch 探测常见云盘端点
  const driveProbes = ['/alice/drive/file/list', '/drive/file/list', '/alice/space/file/list', '/samantha/drive/list'];
  for (const p of driveProbes) {
    const r = await evalJS(`
      (async () => { try {
        const resp = await fetch('${p}?version_code=20800&language=zh&device_platform=web&aid=1044603&real_aid=1044603', { method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json; encoding=utf-8', 'agw-js-conv': 'str' }, body: JSON.stringify({ cmd: 1, sequence_id: window.__uuid() }) });
        const t = await resp.text();
        return resp.status + '|' + (t.trim().startsWith('{') ? t.slice(0, 150) : 'html');
      } catch (e) { return 'err'; } })()
    `);
    console.log('云盘探测', p, '->', String(r).slice(0, 130));
  }
  ws.close();
})().catch(e => { console.error('FATAL', e.message); try { ws && ws.close(); } catch (_) {} process.exit(1); });
