// ==UserScript==
// @name         灯塔-干部网络学院 专栏播放列表
// @namespace    local.gbwlxy
// @version      3.8
// @description  拦截专栏页的课程接口生成播放列表，按顺序播放；1.5 倍速走平台控件；播完自动下一门；跳过随堂测试。
// @match        https://gbwlxy.dtdjzx.gov.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const V = '3.8';
  const KEY = 'gbwlxy_pl_v2';
  const RATE_KEY = 'gbwlxy_rate';
  const SS = window.sessionStorage;

  const log = (...a) => { try { console.log('%c[播放列表]', 'color:#c00;font-weight:bold', '[v' + V + ']', ...a); } catch (e) {} };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const getSS = (k, d) => { try { const v = SS.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const setSS = (k, v) => { try { SS.setItem(k, JSON.stringify(v)); } catch (e) {} };

  let st = getSS(KEY, { items: [], idx: -1, running: false, columnHash: '' });
  const save = () => setSS(KEY, st);

  const getRate = () => {
    const n = Number((() => { try { return SS.getItem(RATE_KEY); } catch (e) { return null; } })());
    return [1, 1.25, 1.5].includes(n) ? n : 1.5;
  };
  let rate = getRate();

  // 是否跳过“含随堂测试”的课（这类课播完也不计学时，默认跳过）
  const SKIP_KEY = 'gbwlxy_skip_test';
  const getSkip = () => { try { return SS.getItem(SKIP_KEY) !== '0'; } catch (e) { return true; } };
  let skipTest = getSkip();

  const currentId = () => { const m = location.hash.match(/courseId=(\d{10,25})/); return m ? m[1] : null; };
  const onCoursePage = () => !!currentId();
  const onExamRoute = () => /\/examManage\//.test(location.hash);

  // ================= 接口响应嗅探 =================
  const netLog = [];               // 最近响应，仅用于诊断
  const NET_MAX = 60;

  // 课程库：一旦在响应里识别到课程就立刻存下来，不参与淘汰，并按来源/专栏分组
  const courseMap = new Map();     // id -> { id, title, ch, test, at, src, col, seq }
  let seq = 0;
  let lastColId = null;            // 最近一次见到的专栏 id，供课程页收集时兜底

  function pushNet(url, json, body) {
    if (netLog.length >= NET_MAX) netLog.shift();
    netLog.push({ url: String(url || '').slice(-100), json: json });
    indexJSON(url, json, body);
    updateCurrentCourse(json);     // 课程详情响应可用来校正“是否含测试”
  }

  // 从请求体里取专栏 id（/subject/queryCourse 的 payload 带 subjectId）
  function columnIdFromBody(body) {
    try {
      const o = typeof body === 'string' ? JSON.parse(body) : body;
      if (o && typeof o === 'object') {
        const v = o.subjectId || o.subjectCode || o.specialId;
        if (v && /^\d{6,25}$/.test(String(v))) return String(v);
      }
    } catch (e) {}
    return null;
  }

  function indexJSON(url, json, body) {
    const found = [];
    walk(json, found, 0);
    if (!found.length) return;
    const src = String(url || '');
    const col = columnIdFromBody(body);
    if (col) lastColId = col;
    for (const c of found) {
      const id = String(c.id || c.courseId);
      if (courseMap.has(id)) continue;
      const hasTest = (c.assessementType !== undefined && c.assessementType !== null && String(c.assessementType) !== '1')
        || (c.examFlag === '0');
      courseMap.set(id, {
        id,
        title: String(c.name || c.courseName || c.title).trim().slice(0, 60),
        ch: Number(c.creditHour) || 0,
        test: hasTest,
        at: c.assessementType === undefined ? 'absent' : String(c.assessementType),
        src: src.slice(-70),
        col: col || null,
        seq: seq++
      });
    }
  }

  // 课程详情接口（/course/web/get）带 assessementType，用来校正列表里判不出的“含测试”
  function updateCurrentCourse(json) {
    const cid = currentId();
    if (!cid || !st.items.length) return;
    const found = [];
    walk(json, found, 0);
    const e = found.find(x => String(x.id || x.courseId) === cid);
    if (!e) return;
    if (e.assessementType === undefined && e.examFlag === undefined) return;
    const t = (e.assessementType !== undefined && e.assessementType !== null && String(e.assessementType) !== '1')
      || e.examFlag === '0';
    const ch = Number(e.creditHour) || 0;
    const rec = courseMap.get(cid);
    if (rec) { rec.test = t; rec.at = e.assessementType === undefined ? rec.at : String(e.assessementType); if (ch) rec.ch = ch; }

    const it = st.items[st.idx];
    if (!it || it.id !== cid) return;
    const changed = it.test !== t;
    it.test = t;
    if (ch) it.ch = ch;
    save(); render();
    if (changed && t) log('📌 这门课实际含随堂测试（列表里没标出来）');
    if (t && skipTest && video && video.currentTime < 25) {
      log('⚠ 含随堂测试且刚开始播，立即跳过');
      nextItem();
    }
  }

  try {
    const of = window.fetch;
    window.fetch = function (...a) {
      return of.apply(this, a).then(function (r) {
        try {
          const ct = r.headers.get('content-type') || '';
          if (/json/i.test(ct)) r.clone().json().then(j => pushNet(a[0], j, a[1] && a[1].body)).catch(function () {});
        } catch (e) {}
        return r;
      });
    };
  } catch (e) { log('fetch 挂钩失败', e.message); }

  try {
    const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u, ...r) { this.__u = u; return oo.call(this, m, u, ...r); };
    XMLHttpRequest.prototype.send = function (...a) {
      this.__b = a[0];
      this.addEventListener('load', function () {
        try {
          const t = this.responseText;
          if (t && t.length < 3000000 && /^[\[{]/.test(t.trim())) pushNet(this.__u, JSON.parse(t), this.__b);
        } catch (e) {}
      });
      return os.apply(this, a);
    };
  } catch (e) { log('XHR 挂钩失败', e.message); }

  // ================= 从 JSON 里找课程 =================
  function isCourse(o) {
    const id = o.id || o.courseId;
    const name = o.name || o.courseName || o.title;
    if (!id || !name) return false;
    if (!/^\d{10,25}$/.test(String(id))) return false;
    if (String(name).length < 2) return false;
    return ('creditHour' in o) || ('showCourseDuration' in o) || ('courseDuration' in o) ||
           ('assessementType' in o) || ('studyStatus' in o) || ('teacher' in o);
  }

  function walk(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 14 || out.length > 500) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, out, depth + 1); return; }
    if (isCourse(node)) { out.push(node); return; }
    for (const k in node) walk(node[k], out, depth + 1);
  }

  function columnIdFromHash() {
    const m = location.hash.match(/[?&]id=(\d{10,25})/);
    return m ? m[1] : null;
  }

  // 优先用专栏接口的课；其次任何带“专栏课程”来源的；最后用全部
  function pickPool() {
    const all = [...courseMap.values()].sort((a, b) => a.seq - b.seq);

    // 1) 最精确：当前正在播的课程属于哪个专栏，就取那个专栏
    const cid = currentId();
    if (cid) {
      const hit = all.find(x => x.id === cid);
      if (hit && hit.col) {
        const by = all.filter(x => x.col === hit.col);
        if (by.length) return { pool: by, label: '当前课程所属专栏 ' + hit.col };
      }
    }

    // 2) 页面 hash 里的专栏 id
    const colId = columnIdFromHash();
    if (colId) {
      const byCol = all.filter(x => x.col === colId);
      if (byCol.length) return { pool: byCol, label: '专栏接口，专栏ID ' + colId };
    }
    // 3) 最近一次见到的专栏
    if (lastColId) {
      const byLast = all.filter(x => x.col === lastColId);
      if (byLast.length) return { pool: byLast, label: '专栏接口，最近专栏 ' + lastColId };
    }
    const byApi = all.filter(x => /subject\/queryCourse/.test(x.src));
    if (byApi.length) return { pool: byApi, label: '专栏课程接口' };
    return { pool: all, label: '页面全部课程' };
  }

  function findPager() {
    const sels = ['.el-pagination .btn-next', '.el-pagination button:last-of-type', '.btn-next', '[class*="pagination"] [class*="next"]'];
    for (const s of sels) {
      const b = document.querySelector(s);
      if (!b) continue;
      const cls = String(b.className || '');
      if (b.disabled || /is-disabled|disabled/.test(cls)) continue;
      const r = b.getBoundingClientRect();
      if (r.width || r.height) return b;
    }
    return [...document.querySelectorAll('a,button,li,span,div')]
      .find(e => e.offsetParent && /^(下一页|下页)$/.test((e.textContent || '').trim())) || null;
  }

  function setMsg(txt, color) {
    if (!panel) return;
    const el = panel.querySelector('.p-msg');
    if (!el) return;
    el.textContent = txt;
    el.style.color = color || '#666';
  }

  async function collectAll() {
    if (st.running) { setMsg('请先停止播放再收集', '#c00'); return; }
    const columnHash = location.hash;
    st.items = []; st.idx = -1; save(); render();

    let picked = pickPool();
    setMsg(`采集中… 已识别 ${courseMap.size} 门（${picked.label}）`);
    log('初始：课程库', courseMap.size, '门，来源', picked.label);

    // 数量不够就翻页/滚动触发新请求，最多 15 轮
    let pages = 0;
    while (pages < 15) {
      const before = picked.pool.length;
      const pager = findPager();
      if (pager) pager.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      else window.scrollTo(0, document.body.scrollHeight);
      await wait(2400);
      picked = pickPool();
      setMsg(`采集中… 第 ${pages + 1} 轮，累计 ${picked.pool.length} 门`, '#0a7');
      log(`第 ${pages + 1} 轮：累计 ${picked.pool.length} 门`);
      pages++;
      if (picked.pool.length === before) break;
      if (picked.pool.length >= 200) break;
    }

    if (!picked.pool.length) {
      setMsg('未解析到课程。点「诊断」把结果发我', '#c00');
      log('⚠ 解析失败。课程库 0 门；已捕获响应：', netLog.map(n => n.url).slice(-10));
      return;
    }

    st.items = picked.pool.map(x => ({ id: x.id, title: x.title, ch: x.ch, test: x.test }));
    st.columnHash = columnHash;
    save(); render();
    setMsg(`✅ 采集完成 ${st.items.length} 门（${picked.label}）`, '#0a7');
    log(`采集完成：${st.items.length} 门，来源 ${picked.label}`);
  }

  // ================= 倍速 =================
  let video = null;
  const findVideo = () => document.querySelector('video.vjs-tech') || document.querySelector('video');

  function applySpeed() {
    const v = video;
    if (!v || Math.abs(v.playbackRate - rate) < 0.01) return;
    try {
      const btn = document.querySelector('.vjs-playback-rate');
      if (btn) {
        btn.click();
        const menu = [...document.querySelectorAll('.vjs-menu-item')].filter(e => e.offsetParent);
        const target = menu.find(e => new RegExp('^' + rate + '\\s*(x|×)?$', 'i').test((e.textContent || '').trim()));
        if (target) { target.click(); log('通过平台控件设为', rate + 'x'); return; }
        btn.click();
      }
    } catch (e) {}
    try { v.playbackRate = rate; } catch (e) {}
  }

  function playNow(v) {
    try { v.muted = true; } catch (e) {}
    applySpeed();
    return v.play().catch(() => {});
  }

  function attach() {
    const v = findVideo();
    if (!v || v === video) return;
    video = v;
    v.addEventListener('ended', onEnded);
    v.addEventListener('pause', onPause);
    log('接管播放器，时长', Math.round(v.duration || 0), '秒');
    if (st.running) playNow(v);
  }

  function onPause() {
    const v = video;
    if (!v || v.ended || !st.running) return;
    const t = v.currentTime;
    setTimeout(() => {
      if (video !== v || v.ended || !st.running) return;
      if (v.paused && Math.abs(v.currentTime - t) < 0.3) playNow(v);
    }, 2500);
  }

  // ================= 播放 =================
  // 导航目标写在 sessionStorage 里，这样平台“整页刷新”后依然知道该去哪一门
  const FIX_KEY = 'gbwlxy_fix';
  let lastNavAt = 0;

  // 真正的整页跳转：加一个时间戳查询参数，强制浏览器重新加载目标课程
  function navigateTo(id) {
    const base = location.href.split('#')[0].split('?')[0];
    const url = base + '?r=' + Date.now() + '#/commend/coursedetail?courseId=' + id + '&flag=kc';
    log('整页跳转到：', url.slice(-70));
    try { location.replace(url); } catch (e) { location.hash = `#/commend/coursedetail?courseId=${id}&flag=kc`; }
  }

  const pageTitle = () => {
    const el = document.querySelector('.path');
    return el ? (el.textContent || '').replace(/\s+/g, '').trim() : '';
  };

  // 到达判定：URL 对上还不够，标题也必须对上（避免“hash 改了但页面没换”）
  function arrivedAt(id) {
    if (currentId() !== id) return false;
    const want = ((st.items.find(x => x.id === id) || {}).title || '').replace(/\s+/g, '');
    const have = pageTitle();
    if (!want || !have) return true;                 // 拿不到标题，退回看 URL
    const a = want.slice(0, 10), b = have.slice(0, 10);
    return have.includes(a) || want.includes(b);
  }

  function bumpFix(id) {
    const o = getSS(FIX_KEY, { id: '', n: 0 });
    if (o.id !== id) { o.id = id; o.n = 0; }
    o.n++;
    setSS(FIX_KEY, o);
    return o.n;
  }

  // 只要期望目标还在、且当前页面不符，就校正过去（跨刷新有效）
  function ensureOnTarget(force) {
    const want = st.expect;
    if (!want || !st.running) return;

    if (arrivedAt(want)) {
      // 到达后要“稳住”15 秒才算成功，防止平台过一会儿又把页面换掉
      if (!st.okAt) { st.okAt = Date.now(); save(); }
      else if (Date.now() - st.okAt > 15000) {
        st.expect = null; st.okAt = 0; save();
        setSS(FIX_KEY, { id: '', n: 0 });
        log('✅ 目标课程已稳定 15 秒', String(st.idx + 1));
      }
      return;
    }

    st.okAt = 0; save();
    if (!force && Date.now() - lastNavAt < 5000) return;
    const n = bumpFix(want);
    if (n > 10) {
      log('⚠ 连续校正失败，停止');
      st.running = false; st.expect = null; save(); render();
      setMsg('跳转失败，已停止（把控制台日志发我）', '#c00');
      return;
    }
    lastNavAt = Date.now();
    log(`→ 校正导航（第 ${n} 次）｜URL课程=${currentId()} 页面标题="${pageTitle().slice(0, 14)}" 目标="${((st.items.find(x => x.id === want) || {}).title || '').slice(0, 14)}"`);
    navigateTo(want);
  }

  function openItem(i) {
    const it = st.items[i];
    if (!it) { st.running = false; save(); render(); return; }
    st.idx = i;
    st.expect = it.id;
    st.expectAt = Date.now();
    st.okAt = 0;
    save(); render();
    log(`→ ${i + 1}/${st.items.length} ${it.title}`);

    if (arrivedAt(it.id)) { return; }   // 已经在这门课上
    navigateTo(it.id);                  // 整页加载目标课程
  }

  // 自动前进时跳过含测试的课（手动点击列表项不跳，尊重你的选择）
  function skipOver(i) {
    if (!skipTest) return i;
    let k = i, n = 0;
    while (k < st.items.length && st.items[k].test) { k++; n++; }
    if (n) log(`跳过 ${n} 门含随堂测试的课（播完也不计学时）`);
    return k;
  }

  function nextItem() {
    if (!st.running) return;
    const i = skipOver(st.idx + 1);
    if (i >= st.items.length) {
      log('🎉 列表全部完成'); setMsg('🎉 全部完成', '#0a7');
      st.running = false; save(); render(); return;
    }
    openItem(i);
  }

  // ================= 结束 / 考试页 =================
  let endedOnce = false, pendingAdvance = false, examHandled = false;

  function onEnded() {
    if (endedOnce) return;
    endedOnce = true;
    log('本门结束');
    setTimeout(() => {
      if (onExamRoute()) { examHandled = true; skipExam(); }
      pendingAdvance = true;
      endedOnce = false;
    }, 2500);
  }

  function skipExam() {
    const b = document.querySelector('button.exitBtn')
      || [...document.querySelectorAll('button, .el-button')].find(x => /^退\s*出$/.test((x.textContent || '').trim()));
    if (b) { b.click(); log('⚠ 随堂测试页，退出跳过（该门不计学时）'); return true; }
    return false;
  }

  setInterval(() => {
    if (!st.running) return;
    if (onExamRoute()) {
      if (!examHandled) { examHandled = true; skipExam(); pendingAdvance = true; }
      return;
    }
    examHandled = false;
    if (pendingAdvance) { pendingAdvance = false; video = null; setTimeout(nextItem, 800); return; }

    // 导航校验：期望目标存在就校正（跨整页刷新依然有效）
    ensureOnTarget(false);

    if (!onCoursePage()) return;

    if (!onCoursePage()) return;
    attach();
    const v = video;
    if (!v) return;
    if (v.paused && !v.ended) playNow(v);
  }, 4000);

  // ================= 面板 =================
  let panel = null;

  function render() {
    if (!panel) return;
    const cur = st.items[st.idx];
    const testN = st.items.filter(x => x.test).length;
    panel.querySelector('.p-status').textContent =
      `${st.items.length ? st.items.length + ' 门' : '空列表'}` +
      (testN ? `（${testN} 门含测试${skipTest ? '·跳过' : ''}）` : '') +
      ` ｜${st.running ? '播放中' : '已停止'}` +
      (cur ? ` ｜${st.idx + 1}. ${cur.title.slice(0, 12)}` : '') + ` ｜${rate}x`;
    panel.querySelector('.p-start').textContent = st.running ? '停止' : '开始';
    const box = panel.querySelector('.p-list');
    box.innerHTML = '';
    st.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.textContent = (i === st.idx ? '▶ ' : '　') + (i + 1) + '. ' + it.title +
        (it.ch ? ` (${it.ch}学时)` : '') + (it.test ? ' ⚠含测试' : '');
      row.style.cssText = 'padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (i === st.idx ? 'background:#ffe8e8;color:#c00;font-weight:600;' : it.test ? 'color:#999;' : 'color:#333;');
      row.onclick = () => { if (!st.running) { st.running = true; save(); } openItem(i); };
      box.appendChild(row);
    });
  }

  function diag() {
    const all = [...courseMap.values()].sort((a, b) => a.seq - b.seq);
    const picked = pickPool();
    const respWithCourse = netLog.filter(r => {
      const f = []; walk(r.json, f, 0); return f.length > 0;
    }).map(r => r.url);

    // 按来源 / 专栏分组，便于判断列表是否混了别的课
    const groups = {};
    all.forEach(x => {
      const k = x.col
        ? 'col:' + x.col
        : 'src:' + ((x.src.split('?')[0].replace(/^.*\/api\//, '') || 'other').slice(0, 40));
      groups[k] = (groups[k] || 0) + 1;
    });

    // DOM 兜底信息：找出页面上“看起来像列表”的容器
    const containers = [...document.querySelectorAll('[class*="list"],[class*="List"],[class*="item"],[class*="Item"]')]
      .filter(e => e.offsetParent)
      .slice(0, 25)
      .map(e => ({
        tag: e.tagName,
        cls: String(e.className).slice(0, 60),
        kids: e.children.length,
        txt: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)
      }));

    const bar = document.querySelector('.vjs-control-bar');

    const out = {
      hash: location.hash,
      capturedResponses: netLog.length,
      capturedUrls: netLog.map(n => n.url).slice(-8),
      responsesWithCourses: respWithCourse.slice(-5),
      courseStore: all.length,
      courseGroups: groups,
      willUse: { source: picked.label, count: picked.pool.length },
      testFlag: {
        markedTrue: picked.pool.filter(x => x.test).length,
        fieldAbsent: picked.pool.filter(x => x.at === 'absent').length,
        atValues: [...new Set(picked.pool.map(x => x.at))].slice(0, 6)
      },
      courseSample: picked.pool.slice(0, 5),
      hasPager: !!findPager(),
      rateControl: !!document.querySelector('.vjs-playback-rate'),
      controlBar: bar ? [...bar.children].map(c => String(c.className).slice(0, 40)) : null,
      currentRate: video ? video.playbackRate : null,
      warnings: [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.children.length === 0 && /倍速|过快|不能超过/.test(e.textContent || '')).map(e => e.textContent.trim()).slice(0, 5),
      listContainers: containers
    };
    const json = JSON.stringify(out, null, 1);
    const ta = panel.querySelector('.p-diag-out');
    ta.value = json; ta.style.display = 'block'; ta.select();
    try { document.execCommand('copy'); setMsg('诊断已复制到剪贴板，粘贴发我', '#0a7'); }
    catch (e) { setMsg('诊断在下方文本框，手动复制', '#c00'); }
    console.log('[播放列表] 诊断', out);
  }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'gbwlxy-pl-panel';
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;width:330px;background:#fff;border:1px solid #c00;border-radius:6px;padding:8px 10px;font:12px/1.6 system-ui;color:#222;box-shadow:0 2px 12px rgba(0,0,0,.22)';
    panel.innerHTML =
      '<div style="font-weight:700;color:#c00">专栏播放列表 v' + V + '</div>' +
      '<div class="p-status" style="color:#555;margin:2px 0 2px">空列表</div>' +
      '<div class="p-msg" style="color:#666;margin:0 0 6px;min-height:16px"></div>' +
      '<div><button class="p-collect">收集本专栏</button>' +
      '<button class="p-start" style="margin-left:6px">开始</button>' +
      '<button class="p-diag" style="margin-left:6px">诊断</button></div>' +
      '<div style="margin-top:6px">倍速 <select class="p-rate">' +
      [1, 1.25, 1.5].map(r => '<option value="' + r + '"' + (r === rate ? ' selected' : '') + '>' + r + 'x</option>').join('') +
      '</select><button class="p-clear" style="margin-left:6px">清空</button></div>' +
      '<div style="margin-top:4px"><label><input type="checkbox" class="p-skip"' + (skipTest ? ' checked' : '') + '> 跳过含测试的课（播完不计学时）</label></div>' +
      '<textarea class="p-diag-out" readonly style="display:none;width:100%;height:90px;margin-top:6px;font:11px monospace"></textarea>' +
      '<div class="p-list" style="max-height:170px;overflow:auto;border-top:1px solid #eee;margin-top:6px;padding-top:4px"></div>';
    (document.body || document.documentElement).appendChild(panel);

    panel.querySelector('.p-collect').onclick = () => collectAll();
    panel.querySelector('.p-start').onclick = () => {
      st.running = !st.running; save(); render();
      if (st.running) {
        if (st.idx < 0) openItem(skipOver(0));
        else if (video) playNow(video);
        else attach();
      }
      log(st.running ? '开始' : '停止');
    };
    panel.querySelector('.p-diag').onclick = diag;
    panel.querySelector('.p-skip').onchange = (e) => {
      skipTest = e.target.checked;
      try { SS.setItem(SKIP_KEY, skipTest ? '1' : '0'); } catch (err) {}
      log(skipTest ? '已开启：跳过含测试的课' : '已关闭：含测试的课也会播放');
      render();
    };
    panel.querySelector('.p-rate').onchange = (e) => {
      rate = Number(e.target.value);
      try { SS.setItem(RATE_KEY, String(rate)); } catch (err) {}
      applySpeed(); log('倍速设为', rate + 'x'); render();
    };
    panel.querySelector('.p-clear').onclick = () => {
      st = { items: [], idx: -1, running: false, columnHash: '' };
      save(); render(); setMsg('已清空');
    };
    render();
    log('面板已创建');
  }

  function start() {
    buildPanel();
    // 调试入口：控制台可用 __gbwlxy.openItem(n) / __gbwlxy.nextItem() 手动验证
    window.__gbwlxy = {
      openItem: (i) => openItem(i),
      nextItem: () => nextItem(),
      state: () => JSON.parse(JSON.stringify(st)),
      nav: () => ({ expect: st.expect, idx: st.idx, current: currentId(), title: pageTitle(), arrived: st.expect ? arrivedAt(st.expect) : null, fix: getSS('gbwlxy_fix', null) })
    };
    // 平台播完可能整页刷新回原课程：开机先按“URL + 页面标题”双重校验
    if (st.running) {
      if (st.expect) setTimeout(() => ensureOnTarget(true), 2000);
      if (onCoursePage()) { log('恢复运行，继续播放'); attach(); }
    }
    let boot = 0;
    const t = setInterval(() => {
      if (!st.running || pendingAdvance || onExamRoute()) return;
      attach();
      const v = video;
      if (v && v.paused && !v.ended && v.readyState >= 2) playNow(v);
      if (++boot > 60) clearInterval(t);
    }, 1000);
    setInterval(render, 2000);
    window.addEventListener('hashchange', () => { video = null; setTimeout(attach, 1200); });
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
