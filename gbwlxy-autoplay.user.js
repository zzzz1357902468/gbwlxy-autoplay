// ==UserScript==
// @name         灯塔-干部网络学院 连续播放（极简版）
// @namespace    local.gbwlxy
// @version      2.2
// @description  点进任意一门课，点「开始」，以 1.5 倍速播放；播完自动顺着页面下方的「课程推荐」继续播下一门；遇到随堂测试自动退出跳过。不跳进度、不伪造任何记录。
// @match        https://gbwlxy.dtdjzx.gov.cn/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const V = '2.3';
  const KEY = 'gbwlxy_simple_running';
  const RATE_KEY = 'gbwlxy_rate';
  const SS0 = window.sessionStorage;
  const getRate = () => {
    const n = Number((() => { try { return SS0.getItem(RATE_KEY); } catch (e) { return null; } })());
    return [1, 1.25, 1.5, 2].includes(n) ? n : 1.5;   // 默认 1.5 倍速
  };
  let rate = getRate();
  const log = (...a) => { try { console.log('%c[连续播放]', 'color:#c00;font-weight:bold', '[v' + V + ']', ...a); } catch (e) {} };

  log('已注入', location.href);

  // ---------- 运行状态 ----------
  // 注意：这个站跳转到下一门课时会清空 localStorage，只有 sessionStorage 能留下来，
  // 所以运行标记和"看过哪些课"必须存在 sessionStorage 里。
  const SS = window.sessionStorage;
  const isRunning = () => { try { return SS.getItem(KEY) === '1'; } catch (e) { return false; } };
  const setRunning = (v) => { try { SS.setItem(KEY, v ? '1' : '0'); } catch (e) {} };

  // ---------- 访问历史，防止在两门课之间来回跳 ----------
  const HKEY = 'gbwlxy_visited';
  const visited = () => { try { return JSON.parse(SS.getItem(HKEY)) || []; } catch (e) { return []; } };
  const markVisited = (id) => {
    const a = visited().filter(x => x !== id);
    a.push(id);
    try { SS.setItem(HKEY, JSON.stringify(a.slice(-40))); } catch (e) {}
  };

  const currentId = () => { const m = location.hash.match(/courseId=(\d{10,25})/); return m ? m[1] : null; };
  const onCoursePage = () => !!currentId();
  const currentTitle = () => {
    const el = document.querySelector('.path') || document.querySelector('.course-detail-warp .path');
    return el ? (el.textContent || '').trim() : '';
  };

  // ---------- 播放器 ----------
  let video = null;

  function findVideo() {
    return document.querySelector('video.vjs-tech') || document.querySelector('video');
  }

  function playNow(v) {
    try { v.muted = true; v.playbackRate = rate; } catch (e) {}
    return v.play().catch(() => {});
  }

  // 平台播放器有时会自己把倍速重置回 1，这里持续校正
  function enforceRate() {
    const v = video;
    if (!v) return;
    try {
      if (Math.abs(v.playbackRate - rate) > 0.01) {
        v.playbackRate = rate;
        log('倍速已被平台重置，重新设为', rate + 'x');
      }
    } catch (e) {}
  }

  function attach() {
    const v = findVideo();
    if (!v) return;
    if (v === video) return;
    video = v;
    v.addEventListener('ended', onEnded);
    v.addEventListener('pause', onPause);
    log('接管播放器，时长', Math.round(v.duration || 0), '秒');
    if (isRunning()) playNow(v);
  }

  function onPause() {
    const v = video;
    if (!v || v.ended || !isRunning()) return;
    const t = v.currentTime;
    setTimeout(() => {
      if (video !== v || v.ended || !isRunning()) return;
      if (v.paused && Math.abs(v.currentTime - t) < 0.3) playNow(v);
    }, 2500);
  }

  // ---------- 随堂测试页：直接退出跳过（不答题） ----------
  function onExamRoute() { return /\/examManage\//.test(location.hash); }

  function skipExam() {
    const b = document.querySelector('button.exitBtn')
      || [...document.querySelectorAll('button, .el-button')].find(x => /^退\s*出$/.test((x.textContent || '').trim()));
    if (b) {
      b.click();
      log('⚠ 进入随堂测试页，已退出跳过（本门不计学时）');
      return true;
    }
    return false;
  }

  // ---------- 随堂测试弹窗：只关闭，不答题 ----------
  function closeQuiz() {
    const boxes = [...document.querySelectorAll('.el-dialog, .el-message-box, .el-dialog__wrapper, [class*="dialog"][class*="quiz"], [class*="exam"]')]
      .filter(d => d.offsetParent && /随堂|答题|作答|测试|考试/.test(d.innerText || ''));
    for (const d of boxes) {
      const cand = [...d.querySelectorAll('button, .el-button, .el-dialog__headerbtn, i[class*="close"], span[class*="close"]')]
        .find(b => /关闭|取消|稍后|退出|×|close/i.test((b.textContent || '') + ' ' + (b.className || '')));
      if (cand) {
        cand.click();
        log('⚠ 检测到随堂测试弹窗，已关闭（不答题，本门不计学时）');
        return true;
      }
    }
    return false;
  }

  // ---------- 播完：顺着「课程推荐」播下一门 ----------
  function cardTitle(el) {
    const t = el.querySelector('.top-title') || el.querySelector('.title') || el;
    return (t.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  }

  function clickRefresh() {
    const b = [...document.querySelectorAll('button, a, span, div')]
      .find(e => e.offsetParent && /^换一换$/.test((e.textContent || '').trim()));
    if (b) { b.click(); log('推荐列表已刷新'); return true; }
    return false;
  }

  async function nextCourse() {
    if (!isRunning()) return;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const cur = currentTitle();
    const seen = visited();

    const getCards = () => [...document.querySelectorAll('.course-list-item')].filter(e => e.offsetParent);
    const pick = () => getCards().find(c => {
      const t = cardTitle(c);
      return t && t !== cur && !seen.some(s => t.includes(s));
    });

    // 播完后播放器会重置、推荐列表要重新渲染，这里最多等 15 秒
    let target = null;
    for (let i = 0; i < 15 && !target; i++) {
      target = pick();
      if (!target) await wait(1000);
    }

    if (!target && clickRefresh()) {          // 推荐都看过了就换一换
      await wait(3000);
      target = pick();
    }

    if (!target) {
      const n = getCards().length;
      log(n ? '推荐里的课都看过了，停止' : '页面上没有推荐课程，停止');
      setRunning(false); render();
      return;
    }

    log('→ 下一门：', cardTitle(target));
    markVisited(cardTitle(target));
    video = null;                             // 让新页面重新接管
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  let endedOnce = false, pendingAdvance = false;

  function onEnded() {
    if (endedOnce) return;
    endedOnce = true;
    log('本门播放结束');
    markVisited(currentTitle());
    closeQuiz();
    // 平台对“有随堂测试”的课会自动跳到考试页，等它跳完再决定下一步
    setTimeout(() => {
      if (onExamRoute()) {
        if (skipExam()) pendingAdvance = true;
      } else {
        pendingAdvance = true;
      }
      endedOnce = false;
    }, 2500);
  }

  // ---------- 看门狗：考试页 / 卡住 / 弹窗 / 被暂停 ----------
  let lastTime = -1, stuckCount = 0, examHandled = false;
  setInterval(() => {
    if (!isRunning()) return;

    // 1) 在随堂测试页 → 退出，然后推进到下一门
    if (onExamRoute()) {
      if (!examHandled) { examHandled = true; if (skipExam()) pendingAdvance = true; }
      render();
      return;
    }
    examHandled = false;

    if (!onCoursePage()) return;

    // 2) 播完（或刚退出考试页）→ 切下一门
    if (pendingAdvance) {
      pendingAdvance = false;
      video = null;
      setTimeout(nextCourse, 800);
      render();
      return;
    }

    attach();
    const v = video;
    if (!v) return;
    enforceRate();

    if (closeQuiz()) setTimeout(() => playNow(v), 800);
    if (v.paused && !v.ended) playNow(v);

    if (!v.paused) {
      if (Math.abs(v.currentTime - lastTime) < 0.4) stuckCount++; else stuckCount = 0;
      lastTime = v.currentTime;
      if (stuckCount >= 8) {           // 约 40 秒没动，判定卡死
        log('⚠ 播放长时间不推进，跳到下一门');
        stuckCount = 0;
        pendingAdvance = true;
      }
    }
  }, 5000);

  // ---------- 悬浮面板 ----------
  let panel = null;
  function render() {
    if (!panel) return;
    const v = video;
    const st = isRunning() ? '运行中' : '已停止';
    const prog = v && v.duration ? ` ｜${Math.round(v.currentTime)}/${Math.round(v.duration)}s` : '';
    const spd = isRunning() ? ` ｜${rate}x` : '';
    panel.querySelector('.s-info').textContent = st + prog + spd;
    panel.querySelector('.s-btn').textContent = isRunning() ? '停止' : '开始';
  }

  function buildPanel() {
    if (panel) return;
    try {
      panel = document.createElement('div');
      panel.id = 'gbwlxy-simple-panel';
      panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;background:#fff;border:1px solid #c00;border-radius:6px;padding:8px 10px;font:12px/1.7 system-ui;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.2)';
      panel.innerHTML =
        '<div style="font-weight:700;color:#c00">连续播放 v' + V + '</div>' +
        '<div class="s-info" style="color:#555;margin:2px 0 6px">已停止</div>' +
        '<button class="s-btn">开始</button>' +
        '<button class="s-reset" style="margin-left:6px" title="清空已看记录">重置记录</button>' +
        '<div style="margin-top:6px">倍速 <select class="s-rate">' +
        [1, 1.25, 1.5, 2].map(r => '<option value="' + r + '"' + (r === rate ? ' selected' : '') + '>' + r + 'x</option>').join('') +
        '</select></div>';
      (document.body || document.documentElement).appendChild(panel);

      panel.querySelector('.s-btn').onclick = () => {
        setRunning(!isRunning());
        if (isRunning()) {
          log('开始');
          attach();
          if (video) playNow(video);
          else setTimeout(() => { attach(); if (video) playNow(video); }, 1500);
        } else log('停止');
        render();
      };
      panel.querySelector('.s-reset').onclick = () => {
        try { SS.removeItem(HKEY); } catch (e) {}
        log('已清空“看过的课程”记录');
      };

      panel.querySelector('.s-rate').onchange = (e) => {
        rate = Number(e.target.value);
        try { SS.setItem(RATE_KEY, String(rate)); } catch (err) {}
        enforceRate();
        if (video && isRunning()) playNow(video);
        log('倍速设为', rate + 'x');
        render();
      };

      render();
      log('面板已创建');
    } catch (e) { log('面板创建失败:', e.message); }
  }

  // ---------- 启动 ----------
  function start() {
    buildPanel();
    if (onCoursePage() && isRunning()) {
      log('恢复上次的运行状态，继续播放');
      attach();
    }
    // 跳下一门是整页刷新，播放器要过一会儿才初始化好，这里前 40 秒每秒试着起播
    let bootTries = 0;
    const boot = setInterval(() => {
      if (!isRunning() || pendingAdvance || onExamRoute()) return;
      attach();
      const v = video;
      enforceRate();
      if (v && v.paused && !v.ended && v.readyState >= 2) playNow(v);
      if (++bootTries > 40) clearInterval(boot);
    }, 1000);

    setInterval(render, 2000);
    window.addEventListener('hashchange', () => { video = null; setTimeout(attach, 1200); });
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
