// ==UserScript==
// @name         灯塔-干部网络学院 专栏播放列表
// @namespace    local.gbwlxy
// @version      3.1
// @description  在专栏页收集全部课程生成播放列表，按顺序播放；1.5 倍速走平台自带控件；播完自动下一门；跳过随堂测试。
// @match        https://gbwlxy.dtdjzx.gov.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const V = '3.1';
  const KEY = 'gbwlxy_pl_v1';
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

  const currentId = () => { const m = location.hash.match(/courseId=(\d{10,25})/); return m ? m[1] : null; };
  const onCoursePage = () => !!currentId();
  const onExamRoute = () => /\/examManage\//.test(location.hash);
  const currentTitle = () => { const el = document.querySelector('.path'); return el ? (el.textContent || '').trim() : ''; };

  // ================= 采集 =================
  const CARD_SEL = '.course-list-item, .video-warp-start, [class*="course-item"], [class*="courseItem"], .el-card';

  function cardTitle(el) {
    const t = el.querySelector('.top-title, .title, .name, h3, h4') || el;
    return (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  // 主策略：直接扫页面里所有带 courseId 的链接（最可靠，不依赖卡片类名）
  function scanAnchors() {
    const out = [];
    document.querySelectorAll('a[href*="courseId="]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/courseId=(\d{10,25})/);
      if (!m) return;
      const card = a.closest(CARD_SEL) || a.parentElement;
      const title = (card ? cardTitle(card) : '') || (a.textContent || '').replace(/\s+/g, ' ').trim();
      out.push({ id: m[1], title: title.slice(0, 60), index: out.length });
    });
    return out;
  }

  // 备选：卡片 + Vue 数据
  function scanCards() {
    const cards = [...document.querySelectorAll(CARD_SEL)].filter(e => e.offsetParent);
    const out = [];
    cards.forEach((el, i) => {
      const title = cardTitle(el);
      if (!title) return;
      let id = null;
      let node = el;
      for (let k = 0; k < 6 && node && !id; k++) {
        const vm = node.__vue__;
        if (vm) {
          const cands = [vm.$props && vm.$props.item, vm.$data && vm.$data.item, vm.item];
          for (const c of cands) {
            if (c && typeof c === 'object') {
              const v = c.id || c.courseId;
              if (v && /^\d{10,25}$/.test(String(v))) { id = String(v); break; }
            }
          }
        }
        node = node.parentElement;
      }
      out.push({ id, title, index: out.length });
    });
    return out;
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

  function setStatus(txt, color) {
    if (!panel) return;
    const el = panel.querySelector('.p-msg');
    if (!el) return;
    el.textContent = txt;
    el.style.color = color || '#666';
  }

  async function collectAll() {
    if (st.running) { setStatus('请先停止播放再收集', '#c00'); return; }
    const columnHash = location.hash;
    const items = [];
    st.items = []; st.idx = -1; save(); render();     // 先清空旧列表，避免误解
    const merge = (arr) => arr.forEach(it => {
      if (!it.title) return;
      if (it.id && items.some(x => x.id === it.id)) return;
      if (items.some(x => x.title === it.title)) return;
      items.push(it);
    });

    setStatus('采集中…');
    let pages = 0;
    while (pages < 20) {
      const anchors = scanAnchors();
      const cards = anchors.length ? [] : scanCards();
      const found = anchors.length ? anchors : cards;
      const before = items.length;
      merge(found);
      setStatus(`采集中… 第 ${pages + 1} 页，本页 ${found.length} 门，累计 ${items.length} 门`, '#0a7');
      log(`第 ${pages + 1} 页：本页 ${found.length} 门，累计 ${items.length} 门`);

      const pager = findPager();
      if (!pager || items.length === before) break;
      pager.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      pages++;
      await wait(2200);
    }

    if (!items.length) {
      const a = document.querySelectorAll('a').length;
      setStatus(`未找到课程（页面共 ${a} 个链接）。点「诊断」并把结果发我`, '#c00');
      log('⚠ 未抓到课程：courseId 链接', document.querySelectorAll('a[href*="courseId="]').length,
          '｜卡片', document.querySelectorAll(CARD_SEL).length, '｜链接总数', a);
      return;
    }

    st.items = items.map((x, i) => ({ id: x.id || null, title: x.title, index: i }));
    st.idx = -1; st.running = false; st.columnHash = columnHash;
    save();
    render();
    const withId = items.filter(x => x.id).length;
    setStatus(`✅ 采集完成 ${items.length} 门（${withId} 门带ID）`, '#0a7');
    log(`采集完成：${items.length} 门，其中 ${withId} 门有课程ID`);
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
        if (target) {
          target.click();
          log('通过平台控件设为', rate + 'x');
          return;
        }
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

  // ================= 播放顺序 =================
  async function openItem(i) {
    const it = st.items[i];
    if (!it) { log('列表已到末尾'); st.running = false; save(); render(); return; }
    st.idx = i; save(); render();

    if (it.id) {
      log(`→ ${i + 1}/${st.items.length} ${it.title}`);
      location.hash = `#/commend/coursedetail?courseId=${it.id}&flag=kc`;
      return;
    }
    log(`→ ${i + 1}/${st.items.length}（按序号点击）${it.title}`);
    if (location.hash !== st.columnHash) { location.hash = st.columnHash; await wait(3000); }
    for (let k = 0; k < 12; k++) {
      const cards = [...document.querySelectorAll(CARD_SEL)].filter(e => e.offsetParent);
      if (cards.length > i) { cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true })); return; }
      await wait(1000);
    }
    setStatus('回专栏页后找不到第 ' + (i + 1) + ' 张卡片', '#c00');
    st.running = false; save(); render();
  }

  function nextItem() {
    if (!st.running) return;
    if (st.idx + 1 >= st.items.length) {
      log('🎉 列表全部完成'); setStatus('🎉 列表全部完成', '#0a7');
      st.running = false; save(); render(); return;
    }
    openItem(st.idx + 1);
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
    panel.querySelector('.p-status').textContent =
      `${st.items.length ? st.items.length + ' 门' : '空列表'} ｜${st.running ? '播放中' : '已停止'}` +
      (cur ? ` ｜${st.idx + 1}. ${cur.title.slice(0, 12)}` : '') + ` ｜${rate}x`;
    panel.querySelector('.p-start').textContent = st.running ? '停止' : '开始';
    const box = panel.querySelector('.p-list');
    box.innerHTML = '';
    st.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.textContent = (i === st.idx ? '▶ ' : '　') + (i + 1) + '. ' + it.title;
      row.style.cssText = 'padding:2px 4px;cursor:pointer;border-radius:3px;' +
        (i === st.idx ? 'background:#ffe8e8;color:#c00;font-weight:600;' : 'color:#333;');
      row.onclick = () => { if (!st.running) { st.running = true; save(); } openItem(i); };
      box.appendChild(row);
    });
  }

  function diag() {
    const anchors = [...document.querySelectorAll('a[href*="courseId="]')];
    const cards = [...document.querySelectorAll(CARD_SEL)].filter(e => e.offsetParent);
    const out = {
      hash: location.hash,
      anchorsWithCourseId: anchors.length,
      anchorSample: anchors.slice(0, 5).map(a => ({ href: (a.getAttribute('href') || '').slice(0, 70), text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) })),
      cards: cards.length,
      cardSample: cards.slice(0, 5).map(c => ({ cls: String(c.className).slice(0, 60), title: cardTitle(c).slice(0, 40) })),
      hasPager: !!findPager(),
      rateControl: !!document.querySelector('.vjs-playback-rate'),
      menuItems: [...document.querySelectorAll('.vjs-menu-item')].map(e => (e.textContent || '').trim()).slice(0, 8),
      currentRate: video ? video.playbackRate : null,
      warnings: [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.children.length === 0 && /倍速|过快|异常|不能超过/.test(e.textContent || '')).map(e => e.textContent.trim()).slice(0, 5)
    };
    const json = JSON.stringify(out, null, 1);
    const ta = panel.querySelector('.p-diag-out');
    ta.value = json;
    ta.style.display = 'block';
    ta.select();
    try { document.execCommand('copy'); setStatus('诊断结果已复制到剪贴板，直接粘贴发我', '#0a7'); }
    catch (e) { setStatus('诊断结果在下方文本框，手动复制', '#c00'); }
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
      '<textarea class="p-diag-out" readonly style="display:none;width:100%;height:90px;margin-top:6px;font:11px monospace"></textarea>' +
      '<div class="p-list" style="max-height:170px;overflow:auto;border-top:1px solid #eee;margin-top:6px;padding-top:4px"></div>';
    (document.body || document.documentElement).appendChild(panel);

    panel.querySelector('.p-collect').onclick = () => collectAll();
    panel.querySelector('.p-start').onclick = () => {
      st.running = !st.running; save(); render();
      if (st.running) {
        if (st.idx < 0) openItem(0);
        else if (video) playNow(video);
        else attach();
      }
      log(st.running ? '开始' : '停止');
    };
    panel.querySelector('.p-diag').onclick = diag;
    panel.querySelector('.p-rate').onchange = (e) => {
      rate = Number(e.target.value);
      try { SS.setItem(RATE_KEY, String(rate)); } catch (err) {}
      applySpeed(); log('倍速设为', rate + 'x'); render();
    };
    panel.querySelector('.p-clear').onclick = () => {
      st = { items: [], idx: -1, running: false, columnHash: '' };
      save(); render(); setStatus('已清空');
    };
    render();
    log('面板已创建');
  }

  function start() {
    buildPanel();
    if (st.running && onCoursePage()) { log('恢复运行，继续播放'); attach(); }
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
