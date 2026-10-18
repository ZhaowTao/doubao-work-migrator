// 全量消息提取 v4：逐页拉取（小 payload）+ 断线重连
const CDP_HTTP = 'http://127.0.0.1:9222';
const fs = require('fs');
const OUT = '/tmp/mda/doubao_export';

let ws = null;
let msgId = 0;
const pending = new Map();

function attach(url) {
  return new Promise((res, rej) => {
    ws = new WebSocket(url);
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error('ws error'));
    ws.onclose = () => { for (const [, p] of pending) p.reject(new Error('WS CLOSED')); pending.clear(); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    };
  });
}

let curTarget = null;
async function ensureConn() {
  if (ws && ws.readyState === 1) return;
  const targetList = await httpGet('/json/list');
  // 找一个 www.doubao.com 页面 target（优先用自己建的）
  let t = targetList.find(x => x.id === curTarget) || targetList.filter(x => x.type === 'page' && x.url.startsWith('https://www.doubao.com')).pop();
  if (!t) throw new Error('no doubao page target');
  curTarget = t.id;
  await attach(t.webSocketDebuggerUrl);
  console.log('(re)connected to', curTarget.slice(0, 8));
}

function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const httpGet = (path, method) => new Promise((res, rej) => {
  require('http').request(CDP_HTTP + path, { method: method || 'GET' }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ __raw: d.slice(0, 80) }); } }); }).on('error', rej).end();
});

const KEEP = ['message_id', 'user_type', 'content_type', 'content', 'thinking_content', 'create_time', 'index_in_conv'];

async function evalJS(expr, retry = 2) {
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      await ensureConn();
      const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
      if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    } catch (e) {
      if (attempt === retry) throw e;
      try { ws.close(); } catch (_) {}
      ws = null;
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

(async () => {
  // 建/复用一个 doubao 页面
  let targetList = await httpGet('/json/list');
  let mine = targetList.filter(x => x.type === 'page' && x.url.startsWith('https://www.doubao.com')).pop();
  if (!mine) {
    const nt = await httpGet('/json/new?https://www.doubao.com/chat/', 'PUT');
    curTarget = nt.targetId || nt.id;
  } else {
    curTarget = mine.id;
  }
  await ensureConn();
  console.log('using target', curTarget.slice(0, 8));

  // 等页面就绪 + 注入 helper
  for (let i = 0; i < 30; i++) {
    const loc = await evalJS(`location.href`, 1).catch(() => '');
    if (typeof loc === 'string' && loc.startsWith('https://www.doubao.com')) break;
    await new Promise(r => setTimeout(r, 500));
  }
  await evalJS(`
    window.__api = async function(path, body) {
      const Q = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop&aid=1044603&real_aid=1044603&pkg_type=release_version';
      const r = await fetch(path + '?' + Q, { method: 'POST',
        headers: { 'Content-Type': 'application/json; encoding=utf-8', 'agw-js-conv': 'str', 'accept': 'application/json, text/plain, */*' },
        body: JSON.stringify(body) });
      const t = await r.text();
      try { return JSON.parse(t); } catch (e) { return { __err: t.slice(0, 100) }; }
    };
    window.__uuid = () => { const h = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0'); return h() + h() + '-' + h() + '-4' + h().slice(1) + '-' + '89ab'[Math.floor(Math.random() * 4)] + h().slice(1) + '-' + h() + h() + h(); };
    window.__KEEP = ${JSON.stringify(KEEP)};
    window.__pullPage = async function(cid, ctype, anchor) {
      const body = (await window.__api('/im/chain/single', { cmd: 3100, sequence_id: window.__uuid(), channel: 2, version: '1',
        uplink_body: { pull_singe_chain_uplink_body: {
          conversation_id: cid, anchor_index: anchor, conversation_type: ctype || 3,
          direction: 1, limit: 50, ext: {}, filter: { index_list: [] },
          evaluate_ab_params: '', evaluate_common_params: '', option: { lazy_load_strategy: 0 }
        } } }))?.downlink_body?.pull_singe_chain_downlink_body;
      if (!body) return { msgs: [], has_more: false };
      const msgs = (body.messages || []).map(m => { const o = {}; for (const k of window.__KEEP) if (m[k] !== undefined) o[k] = m[k]; return o; });
      let minIdx = Infinity;
      for (const m of msgs) { const i = typeof m.index_in_conv === 'number' ? m.index_in_conv : parseInt(m.index_in_conv || '0'); if (i < minIdx) minIdx = i; }
      return { msgs, has_more: !!body.has_more, minIdx: minIdx === Infinity ? null : minIdx };
    };
    'ok'
  `);
  console.log('helpers ready');

  const list = JSON.parse(fs.readFileSync(OUT + '/conv_index.json', 'utf8'));
  console.log('会话数:', list.length);

  // 断点续提
  let allData = {};
  if (fs.existsSync(OUT + '/all_messages.json')) {
    try { allData = JSON.parse(fs.readFileSync(OUT + '/all_messages.json', 'utf8')); } catch (_) {}
  }
  const todo = list.filter(c => !allData[c.id] || !(allData[c.id].messages || []).length);
  console.log('待提取:', todo.length, '（已有', Object.keys(allData).length, '）');

  let done = 0, errs = 0;
  for (const c of todo) {
    try {
      let anchor = 9007199254740991;
      const seen = new Set();
      const msgs = [];
      for (let page = 0; page < 60; page++) {
        const r = await evalJS(`window.__pullPage('${c.id}', 3, ${anchor})`);
        if (!r || !r.msgs || !r.msgs.length) break;
        let added = 0;
        for (const m of r.msgs) {
          if (!seen.has(m.message_id)) { seen.add(m.message_id); msgs.push(m); added++; }
        }
        if (!r.has_more || added === 0) break;
        anchor = (r.minIdx === null ? 0 : r.minIdx) - 1;
        if (anchor < 0) break;
      }
      allData[c.id] = { name: c.name, project: c.project, messages: msgs };
    } catch (e) {
      errs++;
      if (errs <= 5) console.log('  ERR', (c.name || '').slice(0, 20), String(e.message || e).slice(0, 80));
      delete allData[c.id];
    }
    done++;
    if (done % 10 === 0) {
      fs.writeFileSync(OUT + '/all_messages.json', JSON.stringify(allData));
      const tm = Object.values(allData).reduce((a, v) => a + (v.messages || []).length, 0);
      console.log('progress', done + '/' + todo.length, '| convs', Object.keys(allData).length, '| msgs', tm, '| errs', errs);
    }
  }
  fs.writeFileSync(OUT + '/all_messages.json', JSON.stringify(allData));
  const totalMsgs = Object.values(allData).reduce((a, v) => a + (v.messages || []).length, 0);
  console.log('DONE 对话', Object.keys(allData).length, '消息', totalMsgs, '错误', errs);
  ws.close();
})().catch(e => { console.error('FATAL', e.message); try { ws && ws.close(); } catch (_) {} process.exit(1); });
