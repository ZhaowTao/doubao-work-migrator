// 豆包Work 个人记忆提取（API 驱动）
// 接口: POST https://www.doubao.com/chat/memory/list  body {"bot_id": "..."}
// 返回: { data: { agent_soul: [], saved_memory: [{content, date, id}] } }
// 说明: 相对路径会被 App 自定义协议吃掉（返回 SPA HTML），必须用绝对 URL + withCredentials。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { connectByUrl, listTargets } = require('./lib/cdp');

const WORK = process.env.DOUBAO_WORK_DIR || path.join(os.homedir(), '.doubao-migrator');
const OUT = path.join(WORK, 'export');
const CFG = path.join(WORK, 'config.json');
const Q = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop&aid=1044603&real_aid=1044603&pkg_type=release_version';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCfg() { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (_) { return {}; } }
function saveCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); }

// 在页面里发一次记忆请求，返回明细
async function fetchMemories(p, botId) {
  return p.eval(`
    (() => new Promise((resolve) => {
      const x = new XMLHttpRequest();
      x.open('POST', 'https://www.doubao.com/chat/memory/list?${Q}', true);
      x.withCredentials = true;
      x.setRequestHeader('Accept', 'application/json, text/plain, */*');
      x.setRequestHeader('Content-Type', 'application/json');
      x.setRequestHeader('Agw-Js-Conv', 'str');
      x.onload = () => {
        let j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (!j) return resolve({ ok: false, status: x.status, raw: x.responseText.slice(0, 120) });
        resolve({ ok: true, status: x.status,
                  saved: (j.data && j.data.saved_memory) || [],
                  soul: (j.data && j.data.agent_soul) || [],
                  keys: j.data ? Object.keys(j.data) : [] });
      };
      x.onerror = () => resolve({ ok: false, status: 'neterr' });
      x.send(JSON.stringify({ bot_id: ${JSON.stringify(botId)} }));
    }))()
  `);
}

// bot_id 自动发现：挂 XHR hook → 打开设置 → 点记忆 → 读请求体
async function discoverBotId(p) {
  await p.eval(`
    (() => {
      if (window.__botcap) return 'ok';
      window.__botcap = [];
      const osend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function (body) {
        try { if (/\\/chat\\/memory\\/list/.test(this.__url || '')) window.__botcap.push(String(body || '')); } catch (e) {}
        return osend.call(this, body);
      };
      const oo = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__url = u; return oo.call(this, m, u, ...r); };
      return 'ok';
    })()
  `.replace(/\n/g, ' '));

  // Esc 清场
  for (let i = 0; i < 2; i++) {
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
  }

  const openSettings = async () => {
    const b = await p.eval(`
      (() => {
        for (const e of document.querySelectorAll('button,[role=button]')) {
          if ((e.getAttribute('aria-label') || '').trim() === '设置') {
            e.scrollIntoView({ block: 'center' });
            const r = e.getBoundingClientRect();
            if (r.width > 5) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        return null;
      })()
    `.replace(/\n/g, ' '));
    if (!b) return false;
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(1800);
    return true;
  };

  const clickMemoryRow = async () => {
    const row = await p.eval(`
      (() => {
        const d = document.querySelector('[role=dialog]');
        if (!d) return null;
        for (const e of d.querySelectorAll('*')) {
          const t = (e.innerText || '').trim();
          if (t.startsWith('记忆') && t.length < 16) {
            const r = e.getBoundingClientRect();
            if (r.width > 50) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          }
        }
        return null;
      })()
    `.replace(/\n/g, ' '));
    if (!row) return false;
    await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: row.x, y: row.y, button: 'left', clickCount: 1 });
    await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: row.x, y: row.y, button: 'left', clickCount: 1 });
    await sleep(2500);
    return true;
  };

  if (!(await openSettings())) return null;
  if (!(await clickMemoryRow())) return null;

  const bodies = await p.eval(`window.__botcap || []`);
  for (const b of bodies) {
    try {
      const j = JSON.parse(b);
      if (j.bot_id) return String(j.bot_id);
    } catch (_) {}
  }
  return null;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = loadCfg();

  // 记忆接口必须在 App 内页面上下文调用
  let p = null;
  const pages = await listTargets();
  const chat = pages.filter((x) => x.type === 'page' && /doubaowork-chat\/chat/.test(x.url || '')).pop();
  if (!chat) { console.error('未找到豆包Work 聊天页，请确认 App 已启动且挂上 CDP'); process.exit(1); }
  p = await connectByUrl(/doubaowork-chat\/chat/);

  let botId = cfg.bot_id || null;
  if (!botId) {
    console.log('未缓存 bot_id，尝试自动发现（会短暂弹出设置面板）...');
    botId = await discoverBotId(p);
    if (botId) { cfg.bot_id = botId; saveCfg(cfg); console.log('已发现并缓存 bot_id:', botId); }
  }
  if (!botId) { console.error('bot_id 发现失败；可在 config.json 里手动填 bot_id'); process.exit(1); }

  const r = await fetchMemories(p, botId);
  if (!r.ok) { console.error('记忆接口失败:', JSON.stringify(r).slice(0, 200)); process.exit(1); }

  const records = [];
  for (const m of r.saved || []) records.push({ kind: 'saved_memory', content: m.content, date: m.date, id: m.id });
  for (const m of r.soul || []) records.push({ kind: 'agent_soul', content: m.content || JSON.stringify(m), date: m.date || '', id: m.id || '' });

  // 与上一次对比（增删改）
  const prevPath = path.join(OUT, 'memories.json');
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(prevPath, 'utf8')); } catch (_) {}
  const prevMap = new Map(prev.map((x) => [x.id || x.content, x]));
  const curIds = new Set(records.map((x) => x.id || x.content));
  const added = records.filter((x) => !prevMap.has(x.id || x.content));
  const removed = prev.filter((x) => !curIds.has(x.id || x.content));

  fs.writeFileSync(prevPath, JSON.stringify(records, null, 1));
  fs.writeFileSync(path.join(OUT, 'memories_meta.json'), JSON.stringify({
    fetched_at: new Date().toISOString(), bot_id: botId,
    count: records.length, saved: (r.saved || []).length, soul: (r.soul || []).length,
    added: added.map((x) => x.content.slice(0, 40)),
    removed: removed.map((x) => (x.content || '').slice(0, 40)),
  }, null, 1));

  console.log('记忆条数:', records.length, '（saved', (r.saved || []).length, '/ soul', (r.soul || []).length, '）');
  if (prev.length) {
    console.log('对比上次: 新增', added.length, '| 消失/被改', removed.length);
    added.forEach((x) => console.log('  + [' + x.date + ']', x.content.slice(0, 50)));
    removed.forEach((x) => console.log('  - [' + (x.date || '') + ']', (x.content || '').slice(0, 50)));
  } else {
    console.log('（首次提取，无历史可比）');
  }
  p.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
