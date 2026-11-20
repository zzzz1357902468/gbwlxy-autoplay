// ==UserScript==
// @name         灯塔-干部网络学院 专栏播放列表
// @namespace    local.gbwlxy
// @version      3.0
// @description  在专栏页收集全部课程生成播放列表，按顺序播放；1.5 倍速走平台自带控件；播完自动下一门；跳过随堂测试。
// @match        https://gbwlxy.dtdjzx.gov.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const V = '3.0';
  const KEY = 'gbwlxy_pl_v1';        // 播放列表 + 运行状态
  const RATE_KEY = 'gbwlxy_rate';
  const SS = window.sessionStorage;

  const log = (...a) => { try { console.log('%c[播放列表]', 'color:#c00;font-weight:bold', '[v' + V + ']', ...a); } catch (e) {} };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const getSS = (k, d) => { try { const v = SS.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const setSS = (k, v) => { try { SS.setItem(k, JSON.stringify(v)); } catch (e) {} };

  // 状态：{ items:[{id?,title}], idx, running, columnHash, mode }
  let st = getSS(KEY, { items: [], idx: -1, running: false, columnHash: '', mode: 'column' });
  const save = () => setSS(KEY, st);

  const getRate = () => {
    const n = Number((() => { try { return SS.getItem(RATE_KEY); } catch (e) { return null; } })());
    return [1, 1.25, 1.5].includes(n) ? n : 1.5;     // 平台上限 1.5，不给更高
  };
  let rate = getRate();

  const currentId = () => { const m = location.hash.match(/courseId=(\d{10,25})/); return m ? m[1] : null; };
  const onCoursePage = () => !!currentId();
  const onExamRoute = () => /\/examManage\//.test(location.hash);
  const currentTitle = () => {
    const el = document.querySelector('.path');
    return el ? (el.textContent || '').trim() : '';
  };

  // ================= 采集 =================
  function cardTitle(el) {
    const t = el.querySelector('.top-title') || el.querySelector('.title') || el;
    return (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
  }

  function idFromHref(el) {
    const pick = (n) => {
      if (!n) return null;
      if (n.matches && n.matches('a[href*="courseId="]')) {
        const m = (n.getAttribute('href') || '').match(/courseId=(\d{10,25})/);
        if (m) return m[1];
      }
      const a = n.querySelector ? n.querySelector('a[href*="courseId="]') : null;
      if (a) {
        const m = (a.getAttribute('href') || '').match(/courseId=(\d{10,25})/);
        if (m) return m[1];
      }
      return null;
    };
    return pick(el) || pick(el.parentElement);
  }

  // 从卡片上的 Vue 实例里找课程 id（不同页面结构不同，尽力而为）
  function idFromVue(el) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      const vm = node.__vue__;
      if (vm) {
        const cands = [vm.$props && vm.$props.item, vm.$data && vm.$data.item, vm.item, vm.$data];
        for (const c of cands) {
          if (c && typeof c === 'object') {
            const id = c.id || c.courseId;
            if (id && /^\d{10,25}$/.test(String(id))) return String(id);
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function scanCards() {
    const cards = [...document.querySelectorAll('.course-list-item, .video-warp-start, [class*="course-item"]')]
      .filter(e => e.offsetParent);
    const out = [];
    cards.forEach((el, i) => {
      const title = cardTitle(el);
      if (!title) return;
      const id = idFromHref(el) || idFromVue(el);
      out.push({ id: id || null, title, index: i });
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

  function mergeItems(dst, add) {
    add.forEach(it => {
      if (!it.title) return;
      if (dst.some(x => x.title === it.title)) return;
      dst.push(it);
    });
  }

  async function collectAll() {
    if (st.running) return log('先停止播放再收集');
    log('开始采集当前专栏的课程…');
    const items = [];
    const columnHash = location.hash;
    let pages = 0;

    while (pages < 15) {
      const found = scanCards();
      const before = items.length;
      mergeItems(items, found);
      render();
      log(`第 ${pages + 1} 页：本页 ${found.length} 门，累计 ${items.length} 门`);

      const pager = findPager();
      if (!pager || items.length === before) break;
      pager.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      pages++;
      await wait(2200);
    }

    if (!items.length) {
      log('⚠ 没抓到课程。请在「专栏」详情页（能看到课程列表的那一页）点收集，然后用「诊断」把结果发我');
      return;
    }

    const withId = items.filter(x => x.id).length;
    st.items = items.map((x, i) => ({ id: x.id, title: x.title, index: i }));
    st.idx = -1;
    st.running = false;
    st.columnHash = columnHash;
    st.mode = 'column';
    save();
    render();
    log(`✅ 采集完成：${items.length} 门（其中 ${withId} 门带课程ID）`);
    if (!withId) log('注意：这些课程没抓到 ID，播放时靠返回本页按顺序点击');
  }

  // ================= 播放控制 =================
  let video = null;

  const findVideo = () => document.querySelector('video.vjs-tech') || document.querySelector('video');

  // 倍速：优先用平台自己的速度控件，避免被判“倍速过快”
  let speedViaUI = false;
  function applySpeed() {
    const v = video;
    if (!v) return;
    if (Math.abs(v.playbackRate - rate) < 0.01) return;

    // 1) 试平台自带菜单
    try {
      const btn = document.querySelector('.vjs-playback-rate');
      if (btn) {
        btn.click();
        const menus = [...document.querySelectorAll('.vjs-menu-item')].filter(e => e.offsetParent);
        const target = menus.find(e => new RegExp('^' + rate + '(x|×|倍速)?$').test((e.textContent || '').trim()));
        if (target) {
          target.click();
          speedViaUI = true;
          log('已通过平台控件设置为', rate + 'x');
          setTimeout(() => { if (video && Math.abs(video.playbackRate - rate) > 0.01) { video.playbackRate = rate; } }, 300);
          return;
        }
        btn.click();  // 关掉菜单
      }
    } catch (e) {}

    // 2) 回退：直接设置
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
    v.addEventListener('ratechange', () => {
      // 平台把倍速改回 1 时再校正一次（但不与平台来回抢）
      if (st.running && Math.abs(v.playbackRate - rate) > 0.05 && v.playbackRate === 1) {
        setTimeout(() => applySpeed(), 1200);
      }
    });
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

  // ================= 打开第 n 门 =================
  async function openItem(i) {
    const it = st.items[i];
    if (!it) { log('播放列表已到末尾'); st.running = false; save(); render(); return; }
    st.idx = i;
    save();
    render();

    if (it.id) {
      log(`→ 第 ${i + 1}/${st.items.length} 门：${it.title}`);
      location.hash = `#/commend/coursedetail?courseId=${it.id}&flag=kc`;
      return;
    }

    // 没有 ID：回到专栏页，按顺序点第 i 张卡片
    log(`→ 第 ${i + 1}/${st.items.length} 门（按序号点击）：${it.title}`);
    if (location.hash !== st.columnHash) {
      location.hash = st.columnHash;
      await wait(3000);
    }
    for (let k = 0; k < 12; k++) {
      const cards = [...document.querySelectorAll('.course-list-item, .video-warp-start, [class*="course-item"]')].filter(e => e.offsetParent);
      if (cards.length > i) {
        cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return;
      }
      await wait(1000);
    }
    log('⚠ 回到专栏页后没找到第 ' + (i + 1) + ' 张卡片，停止');
    st.running = false; save(); render();
  }

  function nextItem() {
    if (!st.running) return;
    if (st.idx + 1 >= st.items.length) {
      log('🎉 播放列表全部完成');
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
    if (b) { b.click(); log('⚠ 随堂测试页，已退出跳过（该门不计学时）'); return true; }
    return false;
  }

  // ================= 看门狗 =================
  setInterval(() => {
    if (!st.running) return;

    if (onExamRoute()) {
      if (!examHandled) { examHandled = true; skipExam(); pendingAdvance = true; }
      render();
      return;
    }
    examHandled = false;

    if (pendingAdvance) {
      pendingAdvance = false;
      video = null;
      setTimeout(nextItem, 800);
      render();
      return;
    }

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
      (cur ? ` ｜${st.idx + 1}. ${cur.title.slice(0, 14)}` : '') +
      (rate ? ` ｜${rate}x` : '');
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
    const cards = scanCards();
    const sample = cards.slice(0, 3).map(c => ({ title: c.title, id: c.id, index: c.index }));
    const out = {
      url: location.hash,
      cardCount: cards.length,
      cardsWithId: cards.filter(c => c.id).length,
      sample,
      pager: !!findPager(),
      anchorsWithCourseId: document.querySelectorAll('a[href*="courseId="]').length,
      rateControl: !!document.querySelector('.vjs-playback-rate'),
      rateMenuItems: [...document.querySelectorAll('.vjs-menu-item')].map(e => (e.textContent || '').trim()).slice(0, 10),
      currentRate: video ? video.playbackRate : null,
      warnings: [...document.querySelectorAll('*')].filter(e => e.offsetParent && e.children.length === 0 && /倍速|过快|异常/.test(e.textContent || '')).map(e => e.textContent.trim()).slice(0, 5)
    };
    console.log('[播放列表] 诊断', out);
    log('诊断结果已打印（右键复制 JSON 发我）');
    return out;
  }

  function buildPanel() {
    if (panel) return;
    panel = document.createElement('div');
    panel.id = 'gbwlxy-pl-panel';
    panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;width:320px;background:#fff;border:1px solid #c00;border-radius:6px;padding:8px 10px;font:12px/1.6 system-ui;color:#222;box-shadow:0 2px 12px rgba(0,0,0,.22)';
    panel.innerHTML =
      '<div style="font-weight:700;color:#c00">专栏播放列表 v' + V + '</div>' +
      '<div class="p-status" style="color:#555;margin:2px 0 6px">空列表</div>' +
      '<div>' +
      '<button class="p-collect">收集本专栏</button>' +
      '<button class="p-start" style="margin-left:6px">开始</button>' +
      '<button class="p-diag" style="margin-left:6px" title="打印诊断信息">诊断</button>' +
      '</div>' +
      '<div style="margin-top:6px">倍速 <select class="p-rate">' +
      [1, 1.25, 1.5].map(r => '<option value="' + r + '"' + (r === rate ? ' selected' : '') + '>' + r + 'x</option>').join('') +
      '</select><button class="p-clear" style="margin-left:6px">清空</button></div>' +
      '<div class="p-list" style="max-height:180px;overflow:auto;border-top:1px solid #eee;margin-top:6px;padding-top:4px"></div>';
    (document.body || document.documentElement).appendChild(panel);

    panel.querySelector('.p-collect').onclick = () => collectAll();
    panel.querySelector('.p-start').onclick = () => {
      st.running = !st.running;
      save(); render();
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
      applySpeed();
      log('倍速设为', rate + 'x');
      render();
    };
    panel.querySelector('.p-clear').onclick = () => {
      st = { items: [], idx: -1, running: false, columnHash: '', mode: 'column' };
      save(); render();
    };
    render();
    log('面板已创建');
  }

  // ================= 启动 =================
  function start() {
    buildPanel();
    if (st.running && onCoursePage()) {
      log('恢复运行状态，继续播放');
      attach();
    }
    let bootTries = 0;
    const boot = setInterval(() => {
      if (!st.running || pendingAdvance || onExamRoute()) return;
      attach();
      const v = video;
      if (v && v.paused && !v.ended && v.readyState >= 2) playNow(v);
      if (++bootTries > 60) clearInterval(boot);
    }, 1000);
    setInterval(render, 2000);
    window.addEventListener('hashchange', () => { video = null; setTimeout(attach, 1200); });
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
