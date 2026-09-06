/* ============================================================
   李杨明 · 个人主页交互脚本
   —— GitHub 贡献热力图
   数据策略（按优先级）：
     1) data/contributions.json —— 仓库内快照（GitHub Actions 每日生成）
        同源加载：不跨域、不依赖外网，任何网络下都可用 → 立即渲染
     2) 实时社区接口（jogruber / vercel 镜像）—— 后台尝试，成功后升级为实时数据
   ============================================================ */

(function () {
  "use strict";

  var USER = "w25077";
  var SNAPSHOT_URL = "data/contributions.json";     // 同仓库快照
  var LIVE_PROVIDERS = [                            // 实时接口（按顺序择优）
    "https://github-contributions-api.jogruber.de/v4/user/" + USER,
    "https://api.github-contributions.vercel.app/api/" + USER
  ];
  var SNAPSHOT_TIMEOUT_MS = 3000;   // 快照在本地/Pages CDN，应极快
  var LIVE_TIMEOUT_MS = 7000;       // 实时源超时（含大陆网络不佳场景）

  // 热力图栅格常量（与 style.css 中 .gh-canvas 的最小宽度一致）
  // 9px 格子 + 3px 间距：整体宽度更紧凑，能完整放进首页双栏布局
  var CELL = 9;
  var GAP = 3;
  var PITCH = CELL + GAP;
  var WEEKS = 53;
  var DAYS_W = 24;

  var now = new Date();

  /* ---------- 工具 ---------- */

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // 本地日期键 YYYY-MM-DD（与贡献数据比对的最小粒度）
  function dateKey(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  // 宽容解析接口返回的日期：'YYYY-MM-DD' / ISO 字符串 / 毫秒时间戳
  function parseDate(v) {
    if (typeof v === "number") return new Date(v);
    if (typeof v !== "string") return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  // GitHub 风格四档分级（接口未给出 level 时按次数近似）
  function levelOf(count) {
    if (count <= 0) return 0;
    if (count <= 3) return 1;
    if (count <= 6) return 2;
    if (count <= 9) return 3;
    return 4;
  }

  function $(id) { return document.getElementById(id); }

  function fetchJson(url, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    return fetch(url, { signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  // 拉取并归一化；数据为空视为失败
  function fetchPayload(url, timeoutMs) {
    return fetchJson(url, timeoutMs).then(function (payload) {
      var map = collectDays(payload);
      if (map.size === 0) throw new Error("empty payload: " + url);
      return map;
    });
  }

  /* ---------- 数据归一化 ----------
     仓库快照：{ contributions: [{date, count}] }
     jogruber v4：{ contributions: [ {year,total,contributions:[{date,count,level}...]}, ... ] }
     vercel 镜像：{ total:{lastYear}, contributions:[{date,count,level}...] }
     统一拍平成 Map<YYYY-MM-DD, {count, level}> */
  function collectDays(payload) {
    var map = new Map();
    var raw = (payload && Array.isArray(payload.contributions)) ? payload.contributions : [];
    var days = [];

    raw.forEach(function (it) {
      if (it && Array.isArray(it.contributions)) {
        it.contributions.forEach(function (d) { days.push(d); });
      } else if (it) {
        days.push(it);
      }
    });

    days.forEach(function (d) {
      var dt = parseDate(d.date);
      if (!dt) return;
      var count = Math.max(0, Math.round(Number(d.count)) || 0);
      var lvl = Number(d.level);
      if (!(lvl >= 0 && lvl <= 4)) lvl = levelOf(count);
      map.set(dateKey(dt), { count: count, level: lvl });
    });
    return map;
  }

  /* ---------- 时间窗：53 列，末列为当前自然周（周日对齐） ---------- */

  function buildWindow() {
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    var endSun = new Date(today);
    endSun.setDate(endSun.getDate() - endSun.getDay());
    var start = new Date(endSun);
    start.setDate(start.getDate() - (WEEKS - 1) * 7);

    var limit = new Date(today);
    limit.setDate(limit.getDate() - 364);
    var limitKey = dateKey(limit);

    return {
      today: today,
      start: start,
      endSun: endSun,
      limitKey: limitKey,
      startKey: dateKey(start),
      cellAt: function (w, r) { var d = new Date(start); d.setDate(d.getDate() + w * 7 + r); return d; }
    };
  }

  function computeStats(map, win) {
    var total = 0, daysOn = 0;

    map.forEach(function (v, k) {
      if (k < win.startKey || k > dateKey(win.today)) return;
      total += v.count;
      if (v.count > 0) daysOn++;
    });

    return { total: total, daysOn: daysOn };
  }

  /* ---------- 渲染 ---------- */

  function monthLabels(win) {
    var labels = [];
    var y0 = win.start.getFullYear(), m0 = win.start.getMonth();
    var lastDay = new Date(win.endSun);
    lastDay.setDate(lastDay.getDate() + 6);

    for (var k = 0; ; k++) {
      var y = y0 + Math.floor((m0 + k) / 12);
      var m = (m0 + k) % 12;
      var first = new Date(y, m, 1, 12);
      if (first > lastDay) break;
      if (first >= win.start) {
        var col = Math.floor(Math.round((first - win.start) / 86400000) / 7);
        labels.push({ col: col, text: (m + 1) + "月", title: y + "年" + (m + 1) + "月" });
      }
    }
    return labels;
  }

  function renderGraph(map, win, stats) {
    var cellsHtml = "";
    var ariaCount = "过去一年共 " + stats.total + " 次 GitHub 贡献，其中 " + stats.daysOn + " 天有提交。";

    for (var w = 0; w < WEEKS; w++) {
      for (var r = 0; r < 7; r++) {
        var d = win.cellAt(w, r);
        var key = dateKey(d);
        var rec = map.get(key);
        var count = rec ? rec.count : 0;
        var lvl = rec ? rec.level : 0;
        if (d > win.today) { count = 0; lvl = 0; }
        var tip = key + "：" + (count > 0 ? count + " 次贡献" : "无贡献");
        cellsHtml +=
          '<i class="gh-cell l' + lvl + '" style="grid-area:' + (r + 1) + ' / ' + (w + 1) + ';"' +
          ' title="' + tip + '"></i>';
      }
    }

    var months = monthLabels(win);
    var monthsHtml = months.map(function (lb) {
      return '<span style="left:' + (lb.col * PITCH) + 'px;" title="' + lb.title + '">' + lb.text + "</span>";
    }).join("");

    var weekdays = ["", "一", "", "三", "", "五", ""];
    var daysHtml = weekdays.map(function (t, i) {
      return t ? '<span style="grid-row:' + (i + 1) + ';">' + t + "</span>" : "";
    }).join("");

    $("ghMonths").innerHTML = monthsHtml;
    $("ghDays").innerHTML = daysHtml;
    $("ghCells").innerHTML = cellsHtml;
    $("ghCells").setAttribute("aria-label", ariaCount);
  }

  function showMetrics(stats) {
    $("statTotal").textContent = stats.total.toLocaleString("zh-CN");
  }

  function setDataNote(text) {
    var el = $("ghDataTime");
    if (el) el.textContent = text;
  }

  // 快照/实时数据就绪 → 渲染并展示
  function applyData(map, win, noteText) {
    var stats = computeStats(map, win);
    renderGraph(map, win, stats);
    showMetrics(stats);
    // 「关于我」页的"近一年累计 XXX 次"与 Game Boy HUD 同源实时同步
    var yoy = document.getElementById("contribYoY");
    if (yoy) yoy.textContent = stats.total.toLocaleString("zh-CN");
    setDataNote(noteText || "已就绪");
    $("ghLoading").hidden = true;
    $("ghError").hidden = true;
    $("ghState").hidden = true;   // 收起 138px 加载/错误占位层，避免表格上方留白
    $("ghWrap").hidden = false;
    if (window.SnakeGame) window.SnakeGame.resync();   // 格子重建后同步贪吃蛇
  }

  function showLoading() {
    setDataNote("正在获取…");
    $("ghState").hidden = false;
    $("ghLoading").hidden = false;
    $("ghError").hidden = true;
    $("ghWrap").hidden = true;
  }

  function showError() {
    $("ghState").hidden = false;
    $("ghLoading").hidden = true;
    $("ghError").hidden = false;
    $("ghWrap").hidden = true;
  }

  function fmtStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function snapshotNote(payload) {
    var when = fmtStamp(payload && payload.generatedAt);
    return when ? "GitHub Actions · 每日快照 · " + when : "GitHub Actions · 每日快照";
  }

  /* ---------- 加载流程 ----------
     快照先行（秒开）；快照缺失或失败 → 并行尝试实时源；实时源成功后覆盖渲染 */

  function loadLive(win) {
    var tries = LIVE_PROVIDERS.map(function (url) {
      return fetchPayload(url, LIVE_TIMEOUT_MS).catch(function () { return null; });
    });
    return Promise.all(tries).then(function (maps) {
      for (var i = 0; i < maps.length; i++) {
        if (maps[i]) return maps[i];
      }
      throw new Error("no live source available");
    });
  }

  function load() {
    showLoading();
    var win = buildWindow();

    fetchJson(SNAPSHOT_URL, SNAPSHOT_TIMEOUT_MS).then(function (payload) {
      var map = collectDays(payload);
      if (map.size === 0) throw new Error("empty snapshot");
      // 快照立即渲染（同源，任何网络下可用）
      applyData(map, win, snapshotNote(payload));
      // 后台升级：实时源成功 → 换用实时数据（失败则静默保留快照）
      loadLive(win).then(function (liveMap) {
        applyData(liveMap, win, "实时数据（第三方接口 · 缓存 ≤ 1 天）");
      }).catch(function () { /* 保留快照显示 */ });
    }).catch(function () {
      // 快照不可用 → 直接用实时源；全部失败 → 错误提示
      loadLive(win).then(function (liveMap) {
        applyData(liveMap, win, "实时数据（第三方接口 · 缓存 ≤ 1 天）");
      }).catch(function () { showError(); });
    });
  }

  /* ---------- 启动 ---------- */

  var yearEl = $("year");
  if (yearEl) yearEl.textContent = String(now.getFullYear());

  var retry = $("ghRetry");
  if (retry) retry.addEventListener("click", load);

  load();
})();

/* ============================================================
   整页滚动吸附 · 丝滑缓动版
   CSS scroll-snap 的吸附动画速度由浏览器决定且不可调；
   这里接管滚轮/页码点击 → rAF 缓动滚动，可精确控制时长与手感：
   - 累积滚轮量达阈值才翻页（小滚动不打扰）
   - easeOutQuart 缓动（起快收缓），单次翻页 850ms 慢滑
   - 距上次翻页 ≥MIN_GAP(200ms) 的新滚动可打断当前动画 → 连续滚动约 0.2s 翻一页；
     200ms 内到达的惯性残余被忽略，一次大幅手势仍只翻一页
   ============================================================ */
(function () {
  "use strict";

  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  if (!slides.length) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var DURATION = 1000;   // 单次翻页动画时长（ms）：慢速缓动，手感顺滑
  var TRIGGER = 60;      // 触发翻页的累积滚轮量（px）
  var MIN_GAP = 200;     // 连续翻页最小间隔（ms）：到达后可打断动画翻下一页
  var GAP = 180;         // 超过该间隔视为新一轮手势，重置累积量
  var MIN_W = 561;       // 与 style.css 禁用吸附的媒体查询保持一致
  var MIN_H = 681;

  function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

  var index = 0;
  var acc = 0;
  var lastWheelAt = 0;
  var anim = null;
  var animating = false;   // 翻页动画进行中：锁定当前页标记，滚动监听不得改写
  var nextGoAt = 0;      // 距上次滚轮翻页 MIN_GAP 内忽略滚轮（防连飞），之后可打断动画
  // 超高内容屏（如 Steam 封面墙）判定与分区：
  // 视口与这类屏相交 → 返回 true（此时放行原生滚动并关吸附）
  function tallHitAt(y, vh) {
    for (var i = 0; i < slides.length; i++) {
      var s = slides[i];
      if (s.scrollHeight <= vh + 2) continue;
      var top = s.offsetTop;
      var bot = top + s.offsetHeight;
      if (y + vh > top + 1 && y < bot - 1) return true;
    }
    return false;
  }

  // 分区吸附开关：普通页保持吸附 + JS 慢速翻页；
  // 视口进入超高屏才临时关闭（html.free-scroll），离开立即恢复
  var freeOn = false;
  function updateFree() {
    var on = tallHitAt(window.scrollY, window.innerHeight);
    if (on !== freeOn) {
      freeOn = on;
      document.documentElement.classList.toggle("free-scroll", on);
    }
  }
  // 同步置为自由滚动：在滚轮放行原生滚动前立刻关掉 CSS mandatory 吸附，
  // 避免"滚轮 → rAF 更新类"之间那一帧被浏览器吸回吸附点
  function ensureFree() {
    if (!freeOn) {
      freeOn = true;
      document.documentElement.classList.add("free-scroll");
    }
  }
  function refresh() {
    updateFree();
  }
  refresh();
  window.addEventListener("resize", refresh);
  // 动态内容（如 Steam 封面墙异步渲染）完成后需重测高度
  window.addEventListener("site:reflow", refresh);
  window.addEventListener("load", refresh);

  // 翻页能力只与窗口尺寸有关；超高屏区域由 tallHitAt 单独放行
  function enabled() {
    return window.innerWidth >= MIN_W && window.innerHeight >= MIN_H;
  }

  /* —— 页码导航：当前页标记 ——
     以视口垂直中点为基准，选中中点所在的屏 */
  function currentIndex() {
    var mid = window.scrollY + window.innerHeight / 2;
    var best = 0, bestD = Infinity;
    slides.forEach(function (s, i) {
      var d = Math.abs((s.offsetTop + s.offsetHeight / 2) - mid);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  function updateActive(idx) {
    var links = document.querySelectorAll(".pager a");
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle("active", i === idx);
    }
  }

  /* 回到顶部按钮：首页(idx 0)隐藏，其它页显示；
     往下滑动提示：只在首页显示（fixed 锚点不会叠加到其它页） */
  var backBtn = document.getElementById("backToTop");
  var hintEl = document.getElementById("scrollHint");
  function syncMarker(idx) {
    updateActive(idx);
    if (backBtn) backBtn.classList.toggle("show", idx !== 0);
    // 猫点击回顶后（__catReturn）不显示"往下滑动"提示，直到下次手动翻页
    if (hintEl) hintEl.classList.toggle("show", idx === 0 && !window.__catReturn);
  }

  function go(target, viaWheel) {
    target = Math.max(0, Math.min(slides.length - 1, target));
    if (anim !== null) cancelAnimationFrame(anim);   // 打断进行中的动画（连续翻页）
    index = target;
    syncMarker(target);
    animating = true;      // 动画期间锁定标记：直接定格在目标页，避免中途回跳
    if (viaWheel) nextGoAt = performance.now() + MIN_GAP;
    var fromY = window.scrollY;
    var toY = slides[target].offsetTop;
    var start = null;
    var step = function (ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / DURATION);
      window.scrollTo({ top: fromY + (toY - fromY) * easeOutQuart(p), behavior: "auto" });
      if (p < 1) {
        anim = requestAnimationFrame(step);
      } else {
        anim = null;
        animating = false;   // 动画结束：恢复滚动监听同步
        updateFree();        // 落地后校正吸附分区状态
      }
    };
    anim = requestAnimationFrame(step);
  }

  // 快速吸附翻页（不缓动）：用于「超高屏顶缘向上翻」这一确定边界
  function hardGo(target) {
    target = Math.max(0, Math.min(slides.length - 1, target));
    if (anim !== null) cancelAnimationFrame(anim);
    anim = null;
    animating = false;
    index = target;
    window.scrollTo({ top: slides[target].offsetTop, behavior: "auto" });
    syncMarker(target);
    updateFree();
  }

  window.addEventListener("wheel", function (e) {
    if (!enabled() || e.ctrlKey || Math.abs(e.deltaY) < 2) return;  // Ctrl+滚轮=缩放，不拦截
    // 分支 1：在超高屏的顶部区域向上滚 → 快速吸附到上一页（不慢滑、不自由滚动）
    // 覆盖范围：顶缘上方 8px 至墙内下方 120px —— 避免向上滚出墙边界时
    // 落入原生滚动 + mandatory 吸附的空窗而被吸回/吸乱
    if (e.deltaY < 0) {
      for (var i = 0; i < slides.length; i++) {
        var s = slides[i];
        if (s.scrollHeight > window.innerHeight + 2) {
          var d = s.offsetTop - window.scrollY;   // 视口顶距墙顶的距离
          if (d >= -8 && d <= 120) {
            e.preventDefault();
            acc = 0;
            nextGoAt = performance.now() + MIN_GAP;
            window.__catReturn = false;   // 手动向上翻页：恢复提示
            hardGo(index - 1);
            return;
          }
        }
      }
    }
    // 分支 2：视口已进入超高内容屏（Steam 墙内）：放行原生滚动，可自由滚到底
    if (tallHitAt(window.scrollY, window.innerHeight)) {
      ensureFree();   // 同步关闭吸附：首帧原生滚动不会被 mandatory 吸回
      return;
    }
    e.preventDefault();

    var now = performance.now();
    // 距上次翻页不足 MIN_GAP：忽略（吸收单次手势的惯性残余，防止一次连翻多页）
    if (now < nextGoAt) { acc = 0; return; }
    // 间隔过久视为新一轮手势，重置累积量
    if (now - lastWheelAt > GAP) acc = 0;
    lastWheelAt = now;

    // 兼容 line/px 两种滚轮模式
    var dy = (e.deltaMode === 1) ? e.deltaY * 16 : e.deltaY;
    acc += dy;
    if (Math.abs(acc) < TRIGGER) return;
    var dir = acc > 0 ? 1 : -1;
    acc = 0;
    window.__catReturn = false;   // 手动滚轮翻页：恢复"往下滑动"提示
    go(index + dir, true);   // 动画未结束也允许打断 → 连续滚动可约 0.2s 翻一页
  }, { passive: false });

  document.querySelectorAll(".pager a").forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (!enabled()) return;   // 自由滚动模式交给浏览器默认锚点
      e.preventDefault();
      var id = a.getAttribute("href");
      var target = slides.findIndex(function (s) { return "#" + s.id === id; });
      if (target >= 0) {
        window.__catReturn = false;              // 手动点击导航：恢复提示
        go(target, false);
      }
    });
  });

  /* 回到顶部：慢滑回首页（第 1 屏） */
  if (backBtn) {
    backBtn.addEventListener("click", function (e) {
      e.preventDefault();
      window.__catReturn = false;               // 手动回顶：恢复提示
      go(0, false);
    });
  }

  /* 自由滚动（触屏/滚轮原生模式）下实时同步当前页标记与回顶按钮；
   翻页动画进行中（animating）不做同步，标记由 go() 锁定在目标页 */
  var syncScheduled = false;
  window.addEventListener("scroll", function () {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(function () {
      syncScheduled = false;
      if (animating) return;
      updateFree();              // 滚动中跨过超高屏边界时切换吸附开/关
      var ci = currentIndex();
      index = ci;                // 原生滚动后同步翻页基准：避免离开超高屏
                                 // 区域后第一次滚轮按旧 index 错跳一页
      syncMarker(ci);
    });
  }, { passive: true });

  syncMarker(currentIndex());   // 初始状态
  window.__navModule = true;    // 平滑导航模块已就绪（供回顶按钮降级逻辑判断）
  // 供外部调用：慢滑回到网页顶部（猫点击等场景）
  window.SiteNav = {
    goTop: function () { go(0, false); }
  };
})();

/* ============================================================
   贪吃蛇（游戏机 · 贡献格子即棋盘）
   - 53×7 格子为棋盘；撞屏幕边缘从对面穿回（环形世界）
   - 首次按下任意按钮前：AI 自动游玩演示，长度 10
   - 按下任意按钮（机身方向键/A/B 或对应键盘键）→ 接管为玩家
     模式，以长度 3 重新开始
   - 撞到自己身体 → GAME OVER 提示并自动重开（保持当前模式）
   - 机身上下左右（或键盘方向键/WASD）控制方向
   - B（键盘 Z/Shift）按住加速；A（键盘 X/空格）蛇头冒出
     「EAT」思考气泡，持续 1.5s
   - 蛇身从蛇头向蛇尾渐变变透明（最低 50%，可透出屏幕底色）
   - 得分显示在屏幕右上角 LEN n
   ============================================================ */
(function () {
  "use strict";

  var COLS = 53, ROWS = 7, SIZE = COLS * ROWS;
  var BASE_MS = 240, FAST_MS = 100, EAT_MS = 1500, AUTO_LEN = 10;

  var cells = null;          // 已渲染格子（w 主序：index = c*7+r）
  var snake = [];            // 头部在前
  var dirC = 1, dirR = 0;
  var food = null;
  var score = 0;
  var timer = null;
  var running = false;
  var accel = false;
  var bubbleTimer = null;
  var accelPointer = null;
  var mode = "auto";   // "auto"：首次按键前自动游玩（长度 10）；"player"：玩家已接管（长度 3）

  function cellAt(c, r) {
    c = (c + COLS) % COLS; r = (r + ROWS) % ROWS;
    return cells ? cells[c * ROWS + r] : null;
  }

  function ready() {
    var el = document.getElementById("ghCells");
    if (!el || !el.children || el.children.length !== SIZE) return false;
    cells = el.children;
    return true;
  }

  function updateScore() {
    var s = document.getElementById("gbScore");
    if (s) s.textContent = running ? "LEN " + score : "";
  }

  function pickFood() {
    var occ = {};
    snake.forEach(function (p) { occ[p.c + "," + p.r] = 1; });
    var free = [];
    for (var c = 0; c < COLS; c++) {
      for (var r = 0; r < ROWS; r++) {
        if (!occ[c + "," + r]) free.push({ c: c, r: r });
      }
    }
    return free.length ? free[Math.floor(Math.random() * free.length)] : null;
  }

  /* 蛇身透明度渐变：距蛇头越远越透明，最透明不低于 50%
     t = 0 紧邻蛇头（完全不透明，亮黄 #ffd41f），t = 1 蛇尾（半透明，可透出 LCD 底色） */
  var OPACITY_TAIL = 0.5;   // 蛇尾透明度下限 —— 最透明也只能到半透明

  function bodyOpacity(t) {
    t = Math.max(0, Math.min(1, t));
    return Math.max(OPACITY_TAIL, 1 - (1 - OPACITY_TAIL) * t);
  }

  function paint() {
    if (!cells) return;
    var i, n = cells.length;
    var len = snake.length;
    for (i = 0; i < n; i++) {
      cells[i].classList.remove("snake", "snake-head", "food");
      cells[i].style.background = "";   // 清掉上一帧的蛇身内联样式，避免残影
      cells[i].style.opacity = "";
    }
    snake.forEach(function (p, idx) {
      var el = cellAt(p.c, p.r);
      if (!el) return;
      el.classList.add("snake");
      if (idx === 0) {
        el.classList.add("snake-head");               // 蛇头：完全不透明亮黄
      } else {
        el.style.opacity = bodyOpacity(idx / (len - 1));   // 越靠尾越透明（最低 50%）
      }
    });
    if (food) {
      var fe = cellAt(food.c, food.r);
      if (fe) fe.classList.add("food");
    }
  }

  function doOver() {
    running = false;          // 停表：防止调度链在 GAME OVER 期间继续 tick 引发重复弹出
    clearTimeout(timer);
    var screen = document.querySelector(".gb-screen");
    if (screen) {
      // 防重复叠加：先移除旧提示
      var old = screen.querySelector(".gameover");
      if (old) old.remove();
      var o = document.createElement("div");
      o.className = "gameover";
      o.textContent = "GAME OVER";
      screen.appendChild(o);
      setTimeout(function () { o.remove(); }, 1000);
    }
    // 等 GAME OVER 提示结束后再重开：期间棋盘保持碰撞现场，避免蛇/食物瞬间跳位闪动
    setTimeout(function () { if (!running) reset(mode === "auto" ? AUTO_LEN : 3); }, 1000);
  }

  function step() {
    if (!running) return;
    if (mode === "auto") {
      var a = autoDir();
      dirC = a.dc; dirR = a.dr;   // 自动游玩：每步由 AI 决定方向
    }
    var head = snake[0];
    var nc = head.c + dirC, nr = head.r + dirR;
    // 边缘穿越：从对侧回来
    nc = (nc + COLS) % COLS; nr = (nr + ROWS) % ROWS;

    if (snake.some(function (p) { return p.c === nc && p.r === nr; })) {
      doOver();
      return;
    }

    snake.unshift({ c: nc, r: nr });
    if (food && nc === food.c && nr === food.r) {
      score++;
      food = pickFood();
    } else {
      snake.pop();
    }
    paint();
    updateScore();
  }

  function schedule() {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(function () { step(); schedule(); }, accel ? FAST_MS : BASE_MS);
  }

  function reset(len) {
    var l = len || 3;
    snake = [];
    for (var i = 0; i < l; i++) snake.push({ c: 26 - i, r: 3 });
    dirC = 1; dirR = 0;
    score = l;
    accel = false;
    food = pickFood();
    running = true;
    paint();
    updateScore();
    schedule();
  }

  function start() {
    if (!ready() || running) return;
    reset(mode === "auto" ? AUTO_LEN : 3);
  }

  function resync() {
    if (!ready()) return;
    if (!running) { start(); return; }
    paint();   // 格子重建（如实时源升级重绘）后恢复蛇与食物
  }

  /* —— 自动游玩（首次按键前） —— */
  function wrapDist(a, b, n) {
    var d = Math.abs(a - b);
    return Math.min(d, n - d);
  }

  function autoDir() {
    var head = snake[0];
    var turns = [0, 1, -1];        // 候选顺序：直行、顺时针、逆时针
    var safe = [];
    var best = null, bestD = Infinity;
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      var ndc = t === 0 ? dirC : (t === 1 ? -dirR : dirR);
      var ndr = t === 0 ? dirR : (t === 1 ? dirC : -dirC);
      var nc = (head.c + ndc + COLS) % COLS;
      var nr = (head.r + ndr + ROWS) % ROWS;
      if (snake.some(function (p) { return p.c === nc && p.r === nr; })) continue;
      safe.push({ dc: ndc, dr: ndr });
      if (!food) continue;
      // 环形世界曼哈顿距离，选最接近食物的安全方向
      var d = wrapDist(nc, food.c, COLS) + wrapDist(nr, food.r, ROWS);
      if (d < bestD) { bestD = d; best = { dc: ndc, dr: ndr }; }
    }
    if (!food) return safe[0] || { dc: dirC, dr: dirR };
    if (!safe.length) return { dc: dirC, dr: dirR };   // 无安全方向：维持原向（自食 → 重开）
    if (safe.length > 1 && Math.random() < 0.15)       // 小概率随机抖动，避免贪心循环
      return safe[Math.floor(Math.random() * safe.length)];
    return best || safe[0];
  }

  /* 首次按下任意按钮：从自动游玩切换到玩家模式，以长度 3 重新开始 */
  function takeOver() {
    if (mode !== "auto") return;
    mode = "player";
    var o = document.querySelector(".gb-screen .gameover");
    if (o) o.remove();
    reset(3);
  }

  function setDir(dc, dr) {
    if (!running) return;
    if (dc === -dirC && dr === -dirR && snake.length > 1) return;  // 禁止 180° 回头
    dirC = dc; dirR = dr;
  }

  function setAccel(on) {
    accel = on;
    if (running) schedule();   // 立即应用新速度
  }

  function showEat() {
    if (!running || !cells || !food) return;
    var screen = document.querySelector(".gb-screen");
    if (!screen) return;
    var el = cellAt(food.c, food.r);
    if (!el) return;
    var sr = screen.getBoundingClientRect();
    var cr = el.getBoundingClientRect();
    var b = document.createElement("div");
    b.className = "think-bubble";
    b.textContent = "EAT";
    b.style.left = (cr.left - sr.left - 6) + "px";
    b.style.top = (cr.top - sr.top - 30) + "px";
    screen.appendChild(b);
    clearTimeout(bubbleTimer);
    // 「EAT」气泡持续 1.5s 后淡出
    bubbleTimer = setTimeout(function () {
      b.classList.add("out");
      setTimeout(function () { b.remove(); }, 220);
    }, EAT_MS);
  }

  /* —— 机身输入 —— */
  var dirs = {
    up:    { dc: 0, dr: -1 },
    down:  { dc: 0, dr: 1 },
    left:  { dc: -1, dr: 0 },
    right: { dc: 1, dr: 0 }
  };

  document.querySelectorAll(".gb-arm").forEach(function (arm) {
    var d = arm.classList.contains("up") ? dirs.up
      : arm.classList.contains("down") ? dirs.down
      : arm.classList.contains("left") ? dirs.left
      : dirs.right;
    arm.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      takeOver();          // 首次按键 → 玩家模式（长度 3）
      setDir(d.dc, d.dr);
    });
  });

  document.querySelectorAll(".gb-btnwrap").forEach(function (w) {
    var label = w.querySelector("b");
    var key = label ? label.textContent : "";
    var btn = w.querySelector(".gb-btn");
    if (!btn) return;
    if (key === "A") {
      btn.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        takeOver();
        showEat();
      });
    } else if (key === "B") {
      btn.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        takeOver();
        accelPointer = e.pointerId;
        setAccel(true);
      });
    }
  });
  window.addEventListener("pointerup", function (e) {
    if (accelPointer !== null && e.pointerId === accelPointer) {
      accelPointer = null;
      setAccel(false);
    }
  });
  window.addEventListener("pointercancel", function (e) {
    if (accelPointer !== null && e.pointerId === accelPointer) {
      accelPointer = null;
      setAccel(false);
    }
  });

  /* —— 键盘（便于桌面调试） —— */
  window.addEventListener("keydown", function (e) {
    var k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") { e.preventDefault(); takeOver(); setDir(0, -1); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { e.preventDefault(); takeOver(); setDir(0, 1); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); takeOver(); setDir(-1, 0); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); takeOver(); setDir(1, 0); }
    else if (k === "z" || k === "Z" || k === "Shift") { e.preventDefault(); takeOver(); setAccel(true); }
    else if (k === "x" || k === "X" || k === " ") { e.preventDefault(); takeOver(); showEat(); }
  });
  window.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "z" || k === "Z" || k === "Shift") setAccel(false);
  });

  window.SnakeGame = { resync: resync, start: start };
})();

/* ============================================================
   背景装饰：0/1 数码雨（终端绿 · 高密度版）
   - 每条流是笔直的竖线：同流字符严格同列、纵向等距，无抖动
   - 每条流独立：随机起点高度 / 长度 / 间距 / 速度，长短参差
   - 深度分层视差：近层大、亮、快，远层小、暗、慢
   - 终端绿（无发白高亮）：流头最亮，向下渐隐，拖尾短
   - 画布起点右移避开左侧导航（见 #binaryRain CSS）
   - prefers-reduced-motion 下不启动
   ============================================================ */
(function () {
  "use strict";

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var canvas = document.getElementById("binaryRain");
  if (!canvas) return;
  var ctx = canvas.getContext && canvas.getContext("2d");
  if (!ctx) return;

  var RISE = 92;        // 基准上升速度（px/s），再按深度缩放
  var FLIP = 1.3;       // 可见字符每秒随机翻转 0↔1 的概率基数
  var MAX_LEN = 32;     // 单条流同时可见字符上限（长流可超过一屏的 1/3）
  var MIN_GAP = 5.5;    // 相邻流的最小水平间距（px）：更密
  var dpr = window.devicePixelRatio || 1;

  var W = 100;
  var H = 600;
  var xs = [];          // 各条流的固定水平位置（随机散布）
  var streams = [];     // 每条流的状态（null = 空闲）
  var idle = [];        // 空闲倒计时（s）
  var last = 0;

  function setup() {
    W = canvas.clientWidth || 100;
    H = window.innerHeight || 600;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 随机散布列位（保证最小间距，不整齐但互不粘连）；列数更多，密度更高
    var n = Math.max(8, Math.min(24, Math.round(W / 5.5)));
    xs = [];
    var tries = 0;
    while (xs.length < n && tries < 160) {
      tries++;
      var x = 4 + Math.random() * Math.max(8, W - 12);
      var ok = true;
      for (var i = 0; i < xs.length; i++) {
        if (Math.abs(x - xs[i]) < MIN_GAP) { ok = false; break; }
      }
      if (ok) xs.push(x);
    }
    xs.sort(function (a, b) { return a - b; });

    streams = [];
    idle = [];
    for (var c = 0; c < xs.length; c++) idle.push(Math.random() * 0.4);   // 快速填满画面
  }

  // 在某列位发起一条新流：深度 / 起点 / 长度 / 字号 / 速度 / 衰减全随机
  function startStream(i, h) {
    var d = 0.1 + Math.random() * 0.9;               // 深度：1 近 / 0 远
    var y0 = h * (0.08 + Math.random() * 0.87);      // 起点：几乎全屏随机
    // 行程长度混合分布：约一半短流、一半长流（可出现贯穿大半个屏幕的流）
    var travel = Math.random() < 0.5
      ? 45 + Math.random() * 220                       // 短流：45–265
      : 220 + Math.random() * 530;                     // 长流：220–750
    // 期望可见长度（字符串实际铺开的长短）：40–340px 连续随机，且不超过行程
    var visible = Math.min(travel, 40 + Math.random() * 300);
    var spd = RISE * (0.5 + 0.7 * d) * (0.85 + Math.random() * 0.35);
    streams[i] = {
      x: xs[i],
      size: 9 + Math.round(5 * d),                   // 字号 9–14：近大远小，大小错落
      dim: 0.4 + 0.55 * d,                           // 近亮远暗
      spd: spd,
      step: 12 + Math.random() * 6,                  // 字符纵向间距（12–18，疏密随机）
      decay: 3.5 * spd / visible,                    // 按可见长度定制衰减：短流快隐、长流慢隐
      y0: y0,
      y: y0,
      yEnd: y0 - travel,
      next: y0,
      k: 0,
      chars: []
    };
  }

  function tick(ts) {
    if (!last) last = ts;
    var dt = Math.min(0.05, (ts - last) / 1000);
    last = ts;

    if (dt > 0) {
      var i, j;
      // 1) 空闲列位按各自倒计时发起新流
      for (i = 0; i < xs.length; i++) {
        if (!streams[i]) {
          idle[i] -= dt;
          if (idle[i] <= 0) {
            startStream(i, H);
            idle[i] = -1;
          }
        }
      }

      // 2) 推进：列头上移 → 沿途按本流间距生成字符（笔直竖线）
      for (i = 0; i < xs.length; i++) {
        var s = streams[i];
        if (!s) continue;
        s.y -= s.spd * dt;
        var guard = 0;
        while (s.next > 3 && s.y <= s.next && s.chars.length < MAX_LEN && guard++ < 4) {
          s.chars.push({
            y: s.next,                     // 同流字符纵向等距 → 笔直的竖线
            cx: s.x,                       // 同流字符严格同列，无横向偏移
            ch: Math.random() < 0.5 ? "0" : "1",
            glow: 1
          });
          s.k++;
          s.next = s.y0 - s.k * s.step;
        }
        // 字符按本流衰减率渐隐（拖尾长短随流变化）+ 流内随机翻转
        var sf = Math.exp(-s.decay * dt);
        for (j = s.chars.length - 1; j >= 0; j--) {
          var cd = s.chars[j];
          cd.glow *= sf;
          if (cd.glow < 0.03 || cd.y > H + 8) s.chars.splice(j, 1);
          else if (Math.random() < FLIP * dt) cd.ch = cd.ch === "0" ? "1" : "0";
        }
        // 流走完且字符消散 → 释放列位，几乎立刻重新发起（保持高密度）
        if (s.y <= s.yEnd && s.chars.length === 0) {
          streams[i] = null;
          idle[i] = 0.02 + Math.random() * 0.35;
        }
      }

      // 3) 绘制：终端绿三级渐变（头部深绿最亮 → 尾段渐隐），无发白高亮
      ctx.clearRect(0, 0, W, H);
      ctx.textBaseline = "top";
      for (i = 0; i < xs.length; i++) {
        var st = streams[i];
        if (!st || !st.chars.length) continue;
        ctx.font = "600 " + st.size + "px ui-monospace, 'Cascadia Mono', Consolas, monospace";
        for (j = 0; j < st.chars.length; j++) {
          var gc = st.chars[j];
          var a = Math.min(1, gc.glow * st.dim);
          if (gc.glow > 0.7)       ctx.fillStyle = "rgba(0, 245, 92,  " + a.toFixed(3) + ")";
          else if (gc.glow > 0.32) ctx.fillStyle = "rgba(0, 210, 76,  " + a.toFixed(3) + ")";
          else                     ctx.fillStyle = "rgba(0, 158, 60,  " + a.toFixed(3) + ")";
          ctx.fillText(gc.ch, gc.cx - st.size * 0.3, gc.y);
        }
      }
    }
    requestAnimationFrame(tick);
  }

  setup();
  window.addEventListener("resize", setup);
  requestAnimationFrame(tick);
})();

/* ============================================================
   Steam 游戏时长页：读取 data/steam_games.json（Actions 每日快照）
   - 封面墙：每个游戏一张 Steam 封面图，密集平铺，可内滚
   - 封面上叠加名次 + 时长角标，点击跳转 Steam 商店
   - 封面加载失败自动降级为深色底 + 游戏名
   ============================================================ */
(function () {
  "use strict";

  var SUM = document.getElementById("steamSum");
  var BODY = document.getElementById("steamBody");
  var EMPTY = document.getElementById("steamEmpty");
  if (!SUM || !BODY || !EMPTY) return;

  var SNAPSHOT_URL = "data/steam_games.json";
  var CDN = "https://cdn.akamai.steamstatic.com/steam/apps/";

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  function fmtStamp(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || "");
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function fmtHours(h) {
    return Number(h || 0).toLocaleString("zh-CN", { maximumFractionDigits: 1 });
  }

  // 角标时长：≥100h 取整，其余保留 1 位小数
  function shortH(h) {
    h = Number(h || 0);
    return h >= 100 ? String(Math.round(h)) : String(Math.floor(h * 10) / 10);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 内容渲染完成 → 通知滚动模块重新检测页面高度（吸附/自由滚动切换）
  function reflow() {
    if (typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("site:reflow"));
    }
  }

  function tileHtml(g, i) {
    var img = g.appid ? CDN + esc(g.appid) + "/capsule_231x87.jpg" : "";
    var imgTag = img
      ? '<img src="' + img + '" alt="' + esc(g.name) + '" loading="lazy"' +
        ' onerror="this.parentNode.classList.add(\'noimg\')">'
      : "";
    return '<a class="st-tile' + (img ? "" : " noimg") + '" ' +
      'href="https://store.steampowered.com/app/' +
      esc(g.appid) + '" target="_blank" rel="noopener" ' +
      'title="' + esc(g.name) + " · " + esc(shortH(g.hours)) + ' 小时">' +
      imgTag +
      '<span class="st-name">' + esc(g.name) + "</span>" +
      '<span class="st-rank">' + pad2(i + 1) + "</span>" +
      '<b class="st-time">' + esc(shortH(g.hours)) + '<i class="st-u">h</i></b>' +
      "</a>";
  }

  function render(payload) {
    var games = (payload && Array.isArray(payload.games))
      ? payload.games.filter(function (g) { return g && g.hours > 0; })
      : [];
    if (!games.length) {
      SUM.textContent = "暂无时长记录（快照为空）";
      EMPTY.textContent = "首次同步尚未完成：请在仓库配置 STEAM_API_KEY 后，"
        + "手动运行 Actions 中的 “Refresh Steam hours snapshot”。";
      reflow();
      return;
    }
    games.sort(function (a, b) { return (b.hours || 0) - (a.hours || 0); });

    var when = fmtStamp(payload.generatedAt);
    SUM.textContent = "共 " + (payload.totalGames != null ? payload.totalGames : games.length)
      + " 款游戏 · 累计 " + fmtHours(payload.totalHours) + " 小时";

    var tiles = "";
    for (var i = 0; i < games.length; i++) tiles += tileHtml(games[i], i);

    var foot = (payload.source ? "Steam Web API · " : "") +
      (when ? "更新于 " + when : "") + " · GitHub Actions 每日同步";
    EMPTY.hidden = true;
    BODY.innerHTML = '<div class="st-grid">' + tiles + "</div>" +
      '<p class="steam-foot">数据：' + foot + "</p>";
    reflow();
  }

  fetch(SNAPSHOT_URL, { cache: "no-store" }).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }).then(render).catch(function () {
    SUM.textContent = "Steam 数据暂时不可用";
    EMPTY.textContent = "快照加载失败：请确认 data/steam_games.json 已存在，"
      + "并手动运行 Actions 中的 “Refresh Steam hours snapshot”。";
    reflow();
  });
})();

/* ============================================================
   回到顶部按钮 · 降级逻辑
   - 主平滑导航模块（window.__navModule）启用时，显示状态与
     慢滑回顶均由该模块负责，这里不重复处理
   - 模块未启用（如 prefers-reduced-motion）时：按滚动位置
     显示按钮，点击用原生平滑滚动回顶
   ============================================================ */
(function () {
  "use strict";
  var btn = document.getElementById("backToTop");
  var hintEl = document.getElementById("scrollHint");
  if (!btn && !hintEl) return;
  if (window.__navModule) return;   // 主模块已接管

  if (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      try {
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (err) { /* 老浏览器 */ window.scrollTo(0, 0); }
    });
  }

  var pending = false;
  window.addEventListener("scroll", function () {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      var y = window.scrollY;
      var vh = window.innerHeight;
      if (btn) btn.classList.toggle("show", y > vh * 0.4);
      if (hintEl) hintEl.classList.toggle("show", y < vh * 0.6);
    });
  }, { passive: true });
})();

/* ============================================================
   底部小猫互动：点击 → 气泡"哈！" → 0.5s 后慢滑回网页顶部
   ============================================================ */
(function () {
  "use strict";
  var img = document.getElementById("catImg");
  var bubble = document.getElementById("catBubble");
  if (!img || !bubble) return;

  var hideTimer = null;    // 气泡确认定时器（保持 0.3s 显示时长）
  img.addEventListener("click", function () {
    // 连续点击不叠加：重置气泡定时器
    clearTimeout(hideTimer);
    bubble.classList.add("show");
    // 气泡显示时长保持现状（0.3s 后淡出）
    hideTimer = setTimeout(function () {
      bubble.classList.remove("show");
    }, 300);
    // 同时立即回到网页顶部（与气泡出现同步）
    window.__catReturn = true;                // 猫带回顶：抑制"往下滑动"提示
    if (window.SiteNav && window.SiteNav.goTop) {
      window.SiteNav.goTop();                       // 站内慢滑回顶
    } else {
      try { window.scrollTo({ top: 0, behavior: "smooth" }); }
      catch (err) { window.scrollTo(0, 0); }        // 降级（如减少动效）
    }
  });
})();
