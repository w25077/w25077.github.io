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
  var CELL = 11;
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

  var DURATION = 850;    // 单次翻页动画时长（ms）
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
  var nextGoAt = 0;      // 距上次滚轮翻页 MIN_GAP 内忽略滚轮（防连飞），之后可打断动画
  var fits = true;

  function refresh() {
    // 任一页内容高于视口时退回原生滚动，防止页底内容够不到
    fits = slides.every(function (s) {
      return s.scrollHeight <= window.innerHeight + 2;
    });
    document.documentElement.classList.toggle("free-scroll", !fits);
  }
  refresh();
  window.addEventListener("resize", refresh);

  function enabled() {
    return fits && window.innerWidth >= MIN_W && window.innerHeight >= MIN_H;
  }

  function go(target, viaWheel) {
    target = Math.max(0, Math.min(slides.length - 1, target));
    if (anim !== null) cancelAnimationFrame(anim);   // 打断进行中的动画（连续翻页）
    index = target;
    if (viaWheel) nextGoAt = performance.now() + MIN_GAP;
    var fromY = window.scrollY;
    var toY = slides[target].offsetTop;
    var start = null;
    var step = function (ts) {
      if (start === null) start = ts;
      var p = Math.min(1, (ts - start) / DURATION);
      window.scrollTo({ top: fromY + (toY - fromY) * easeOutQuart(p), behavior: "auto" });
      anim = (p < 1) ? requestAnimationFrame(step) : null;
    };
    anim = requestAnimationFrame(step);
  }

  window.addEventListener("wheel", function (e) {
    if (!enabled() || e.ctrlKey || Math.abs(e.deltaY) < 2) return;  // Ctrl+滚轮=缩放，不拦截
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
    go(index + dir, true);   // 动画未结束也允许打断 → 连续滚动可约 0.2s 翻一页
  }, { passive: false });

  document.querySelectorAll(".pager a").forEach(function (a) {
    a.addEventListener("click", function (e) {
      if (!enabled()) return;   // 自由滚动模式交给浏览器默认锚点
      e.preventDefault();
      var id = a.getAttribute("href");
      var target = slides.findIndex(function (s) { return "#" + s.id === id; });
      if (target >= 0) go(target, false);   // 页码点击是明确意图，不受最小间隔限制
    });
  });
})();

/* ============================================================
   贪吃蛇（游戏机 · 贡献格子即棋盘）
   - 53×7 格子为棋盘；撞屏幕边缘从对面穿回（环形世界）
   - 撞到自己身体 → GAME OVER 提示并自动重开
   - 机身上下左右（或键盘方向键/WASD）控制方向
   - B（键盘 Z/Shift）按住加速；A（键盘 X/空格）蛇头冒出
     「EAT」思考气泡，持续 1.5s
   - 得分显示在屏幕右上角 LEN n
   ============================================================ */
(function () {
  "use strict";

  var COLS = 53, ROWS = 7, SIZE = COLS * ROWS;
  var BASE_MS = 240, FAST_MS = 100, EAT_MS = 1500;

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

  function paint() {
    if (!cells) return;
    var i, n = cells.length;
    for (i = 0; i < n; i++) cells[i].classList.remove("snake", "snake-head", "food");
    snake.forEach(function (p, idx) {
      var el = cellAt(p.c, p.r);
      if (!el) return;
      el.classList.add("snake");
      if (idx === 0) el.classList.add("snake-head");
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
    setTimeout(function () { if (!running) reset(); }, 1000);
  }

  function step() {
    if (!running) return;
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

  function reset() {
    snake = [{ c: 26, r: 3 }, { c: 25, r: 3 }, { c: 24, r: 3 }];
    dirC = 1; dirR = 0;
    score = 3;
    accel = false;
    food = pickFood();
    running = true;
    paint();
    updateScore();
    schedule();
  }

  function start() {
    if (!ready() || running) return;
    reset();
  }

  function resync() {
    if (!ready()) return;
    if (!running) { start(); return; }
    paint();   // 格子重建（如实时源升级重绘）后恢复蛇与食物
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
        showEat();
      });
    } else if (key === "B") {
      btn.addEventListener("pointerdown", function (e) {
        e.preventDefault();
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
    if (k === "ArrowUp" || k === "w" || k === "W") { e.preventDefault(); setDir(0, -1); }
    else if (k === "ArrowDown" || k === "s" || k === "S") { e.preventDefault(); setDir(0, 1); }
    else if (k === "ArrowLeft" || k === "a" || k === "A") { e.preventDefault(); setDir(-1, 0); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { e.preventDefault(); setDir(1, 0); }
    else if (k === "z" || k === "Z" || k === "Shift") { e.preventDefault(); setAccel(true); }
    else if (k === "x" || k === "X" || k === " ") { e.preventDefault(); showEat(); }
  });
  window.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "z" || k === "Z" || k === "Shift") setAccel(false);
  });

  window.SnakeGame = { resync: resync, start: start };
})();
