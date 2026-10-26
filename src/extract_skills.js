// 豆包Work 技能清单提取：POST /samantha/skill/list（GET 会 404，API 已改方法）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { listTargets, connect, newTab } = require('./lib/cdp');

const WORK = process.env.DOUBAO_WORK_DIR || path.join(os.homedir(), '.doubao-migrator');
const OUT = path.join(WORK, 'export');
const Q = 'version_code=20800&language=zh&device_platform=web&doubao_device_platform=desktop&aid=1044603&real_aid=1044603&pkg_type=release_version';

(async () => {
  let list = await listTargets();
  let t = list.filter((x) => x.type === 'page' && (x.url || '').startsWith('https://www.doubao.com')).pop();
  if (!t) {
    const id = await newTab('https://www.doubao.com/chat/');
    await new Promise((r) => setTimeout(r, 5000));
    t = (await listTargets()).find((x) => x.id === id);
  }
  const p = await connect(t.webSocketDebuggerUrl).open();
  await p.waitForUrl(/^https:\/\/www\.doubao\.com/, 40, 500).catch(() => {});

  const r = await p.eval(`
    (() => new Promise((res) => {
      const x = new XMLHttpRequest();
      x.open('POST', 'https://www.doubao.com/samantha/skill/list?${Q}', true);
      x.withCredentials = true;
      x.setRequestHeader('Accept', 'application/json, text/plain, */*');
      x.setRequestHeader('Content-Type', 'application/json');
      x.setRequestHeader('Agw-Js-Conv', 'str');
      x.onload = () => {
        let j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (!j) return res({ ok: false, status: x.status, raw: x.responseText.slice(0, 120) });
        res({ ok: true, skills: (j.data && j.data.skills) || [],
              groups: {
                input: (j.data && j.data.input_skill) || [],
                sidebar: (j.data && j.data.sidebar_skill) || [],
                recommend: (j.data && j.data.recommend_skill) || [],
              },
              keys: j.data ? Object.keys(j.data) : [], hasMore: j.data && j.data.has_more });
      };
      x.onerror = () => res({ ok: false, status: 'neterr' });
      x.send('{}');
    }))()
  `);

  if (!r.ok) { console.error('技能接口失败:', JSON.stringify(r)); process.exit(1); }
  // 合并各分组（跨组去重），只保留可读字段，避免把内部配置写进归档
  const all = [...(r.skills || [])];
  for (const g of Object.values(r.groups || {})) {
    if (Array.isArray(g)) all.push(...g);
    else if (g && Array.isArray(g.skills)) all.push(...g.skills);
  }
  const seen = new Set();
  const slim = [];
  for (const s of all) {
    const nm = s.show_name || s.name || '';
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    slim.push({ name: nm, name_short: s.show_name_short || '', type: s.skill_type, description: (s.description || '').split('\n')[0] });
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'skills.json'), JSON.stringify(slim, null, 1));
  console.log('技能数:', slim.length, '| data keys:', (r.keys || []).join(','), '| has_more:', r.hasMore || false);
  slim.slice(0, 8).forEach((s) => console.log('  -', s.name, '|', (s.description || '').slice(0, 36)));
  p.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
