// 轻量 CDP 客户端：零依赖（Node 18+ 自带 WebSocket）
// 用法: const { connect, connectByUrl, httpGet, newTab } = require('./lib/cdp');
const http = require('http');

const CDP_HTTP = process.env.DOUBAO_CDP || 'http://127.0.0.1:9222';

function httpGet(path, method) {
  return new Promise((res, rej) => {
    const req = http.request(CDP_HTTP + path, { method: method || 'GET' }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({ __raw: d.slice(0, 200) }); } });
    });
    req.on('error', rej);
    req.end();
  });
}

async function listTargets() {
  return httpGet('/json/list');
}

async function newTab(url) {
  const r = await httpGet('/json/new?' + encodeURI(url), 'PUT');
  return r.id || r.targetId;
}

function connect(wsUrl) {
  let ws = null, msgId = 0;
  const pending = new Map();
  let closed = false;

  const api = {
    get closed() { return closed; },
    async open() {
      await new Promise((res, rej) => {
        ws = new WebSocket(wsUrl);
        ws.onopen = res;
        ws.onerror = () => rej(new Error('ws error'));
        ws.onclose = () => {
          closed = true;
          for (const [, p] of pending) p.reject(new Error('WS CLOSED'));
          pending.clear();
        };
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
          }
        };
      });
      return api;
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    // 求值并返回 JS 值
    async eval(expr, timeout = 120000) {
      const r = await api.send('Runtime.evaluate', {
        expression: expr, awaitPromise: true, returnByValue: true, timeout,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('JS: ' + (d.exception && d.exception.description ? d.exception.description.slice(0, 300) : JSON.stringify(d).slice(0, 300)));
      }
      return r.result.value;
    },
    // 等待页面地址匹配（处理页面重载/新建 tab 尚未导航完成）
    async waitForUrl(re, tries = 40, gap = 500) {
      let loc = '';
      for (let i = 0; i < tries; i++) {
        loc = await api.eval('location.href', 20000).catch(() => '');
        if (typeof loc === 'string' && re.test(loc)) return loc;
        await new Promise((r) => setTimeout(r, gap));
      }
      throw new Error('waitForUrl timeout, last=' + loc);
    },
    close() { try { ws.close(); } catch (_) {} closed = true; },
  };
  return api;
}

// 连接到 URL 匹配指定正则的 page target；没有则新建
async function connectByUrl(matchRe, createUrl) {
  const list = await listTargets();
  const re = matchRe instanceof RegExp ? matchRe : new RegExp(matchRe);
  let t = list.filter((x) => x.type === 'page' && re.test(x.url || '')).pop();
  if (!t) {
    if (!createUrl) throw new Error('no matching page target: ' + matchRe);
    const id = await newTab(createUrl);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const l2 = await listTargets();
      t = l2.find((x) => x.id === id);
      if (t && t.webSocketDebuggerUrl) break;
    }
    if (!t) throw new Error('new tab not found: ' + id);
  }
  return connect(t.webSocketDebuggerUrl).open();
}

module.exports = { CDP_HTTP, httpGet, listTargets, newTab, connect, connectByUrl };
