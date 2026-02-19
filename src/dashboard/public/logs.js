// logs.js — Live log streaming viewer
// Plain vanilla JS — no modules, no dependencies

(function () {
  "use strict";

  // ── Constants ──────────────────────────────────────────────────────────────

  var MAX_DOM_LINES = 2000;
  var PRUNE_COUNT = 200;
  var RECONNECT_DELAY = 3000;
  var FILTER_DEBOUNCE = 300;

  var LEVEL_BG = {
    trace: "bg-gray-400/10 text-gray-500",
    debug: "bg-gray-400/10 text-gray-400",
    info: "bg-blue-400/10 text-blue-400",
    warn: "bg-amber-400/10 text-amber-400",
    error: "bg-red-400/10 text-red-400",
    fatal: "bg-red-600/20 text-red-600",
  };

  var LEVEL_MSG_COLOR = {
    trace: "text-gray-500",
    debug: "text-gray-400",
    info: "text-blue-400",
    warn: "text-amber-400",
    error: "text-red-400",
    fatal: "text-red-600",
  };

  // ── State ──────────────────────────────────────────────────────────────────

  var eventSource = null;
  var paused = false;
  var pauseBuffer = [];
  var autoScroll = true;
  var entryCount = 0;
  var knownComponents = {};
  var filterTimer = null;

  // ── DOM refs ───────────────────────────────────────────────────────────────

  var container, statusDot, statusText, pauseBtn, clearBtn, countEl,
    scrollBtn, componentSelect, taskIdInput, searchInput;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var h = String(d.getHours()).padStart(2, "0");
    var m = String(d.getMinutes()).padStart(2, "0");
    var s = String(d.getSeconds()).padStart(2, "0");
    var ms = String(d.getMilliseconds()).padStart(3, "0");
    return h + ":" + m + ":" + s + "." + ms;
  }

  function setConnected(connected) {
    if (connected) {
      statusDot.className = "h-2.5 w-2.5 rounded-full bg-emerald-400";
      statusText.textContent = "Connected";
      statusText.className = "text-emerald-400";
    } else {
      statusDot.className = "h-2.5 w-2.5 rounded-full bg-red-400";
      statusText.textContent = "Disconnected";
      statusText.className = "text-red-400";
    }
  }

  function setConnecting() {
    statusDot.className = "h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse";
    statusText.textContent = "Connecting...";
    statusText.className = "text-amber-400";
  }

  function updateCount() {
    var suffix = paused ? " (paused: +" + pauseBuffer.length + ")" : "";
    countEl.textContent = entryCount + " entries" + suffix;
  }

  function pruneIfNeeded() {
    if (container.childElementCount > MAX_DOM_LINES) {
      for (var i = 0; i < PRUNE_COUNT && container.firstChild; i++) {
        container.removeChild(container.firstChild);
      }
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function renderEntry(entry) {
    var line = document.createElement("div");
    line.className = "flex gap-2 py-0.5 hover:bg-slate-900/50";

    var time = '<span class="text-slate-500 shrink-0">' + esc(formatTime(entry.time)) + "</span>";

    var levelCls = LEVEL_BG[entry.levelLabel] || LEVEL_BG.info;
    var level = '<span class="inline-flex items-center justify-center w-12 rounded px-1 text-center text-[10px] font-medium uppercase ' + levelCls + '">' + esc(entry.levelLabel) + "</span>";

    var comp = '<span class="text-slate-500 shrink-0">[' + esc(entry.component) + "]</span>";

    var taskTag = "";
    if (entry.taskId) {
      taskTag = '<span class="rounded bg-slate-800 px-1 text-[10px] text-slate-400 shrink-0">task:' + esc(entry.taskId) + "</span>";
    }

    var msgColor = LEVEL_MSG_COLOR[entry.levelLabel] || "text-slate-300";
    var msg = '<span class="' + msgColor + ' break-all">' + esc(entry.msg) + "</span>";

    line.innerHTML = time + level + comp + taskTag + msg;
    container.appendChild(line);

    if (entry.err) {
      var errEl = document.createElement("div");
      errEl.className = "ml-16 text-red-400/80 whitespace-pre-wrap py-0.5";
      errEl.textContent = entry.err;
      container.appendChild(errEl);
    }

    // Track component
    if (entry.component && !knownComponents[entry.component]) {
      knownComponents[entry.component] = true;
      updateComponentDropdown();
    }

    entryCount++;
    updateCount();
    pruneIfNeeded();

    if (autoScroll) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function addSeparator(text) {
    var sep = document.createElement("div");
    sep.className = "flex items-center gap-3 py-2";
    sep.innerHTML =
      '<div class="flex-1 border-t border-slate-700"></div>' +
      '<span class="text-[10px] uppercase tracking-wider text-slate-500">' + esc(text) + "</span>" +
      '<div class="flex-1 border-t border-slate-700"></div>';
    container.appendChild(sep);
  }

  function updateComponentDropdown() {
    var current = componentSelect.value;
    var sorted = Object.keys(knownComponents).sort();
    componentSelect.innerHTML = '<option value="">All</option>';
    for (var i = 0; i < sorted.length; i++) {
      var opt = document.createElement("option");
      opt.value = sorted[i];
      opt.textContent = sorted[i];
      if (sorted[i] === current) opt.selected = true;
      componentSelect.appendChild(opt);
    }
  }

  // ── SSE connection ─────────────────────────────────────────────────────────

  function getFilterParams() {
    var params = [];

    var checks = document.querySelectorAll(".log-level-filter:checked");
    var levels = [];
    for (var i = 0; i < checks.length; i++) {
      levels.push(checks[i].value);
    }
    if (levels.length > 0 && levels.length < 5) {
      params.push("level=" + encodeURIComponent(levels.join(",")));
    }

    var comp = componentSelect.value;
    if (comp) params.push("component=" + encodeURIComponent(comp));

    var tid = taskIdInput.value.trim();
    if (tid) params.push("taskId=" + encodeURIComponent(tid));

    var search = searchInput.value.trim();
    if (search) params.push("search=" + encodeURIComponent(search));

    return params.length > 0 ? "?" + params.join("&") : "";
  }

  function connect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    setConnecting();

    var url = "/logs/stream" + getFilterParams();
    eventSource = new EventSource(url);

    eventSource.onopen = function () {
      setConnected(true);
    };

    eventSource.onmessage = function (e) {
      try {
        var entry = JSON.parse(e.data);
        if (paused) {
          pauseBuffer.push(entry);
          updateCount();
        } else {
          renderEntry(entry);
        }
      } catch (_err) {
        // ignore parse errors
      }
    };

    eventSource.addEventListener("backfill-complete", function () {
      addSeparator("live");
    });

    eventSource.onerror = function () {
      setConnected(false);
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setTimeout(connect, RECONNECT_DELAY);
    };
  }

  // ── Filter change handler ──────────────────────────────────────────────────

  function onFilterChange() {
    if (filterTimer) clearTimeout(filterTimer);
    filterTimer = setTimeout(function () {
      container.innerHTML = "";
      entryCount = 0;
      pauseBuffer = [];
      updateCount();
      connect();
    }, FILTER_DEBOUNCE);
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", function () {
    container = document.getElementById("log-container");
    statusDot = document.getElementById("status-dot");
    statusText = document.getElementById("status-text");
    pauseBtn = document.getElementById("log-pause");
    clearBtn = document.getElementById("log-clear");
    countEl = document.getElementById("log-count");
    scrollBtn = document.getElementById("log-scroll-bottom");
    componentSelect = document.getElementById("log-component");
    taskIdInput = document.getElementById("log-task-id");
    searchInput = document.getElementById("log-search");

    if (!container) return; // Not on the logs page

    // Pause / Resume
    pauseBtn.addEventListener("click", function () {
      paused = !paused;
      pauseBtn.textContent = paused ? "Resume" : "Pause";
      if (!paused) {
        for (var i = 0; i < pauseBuffer.length; i++) {
          renderEntry(pauseBuffer[i]);
        }
        pauseBuffer = [];
      }
      updateCount();
    });

    // Clear
    clearBtn.addEventListener("click", function () {
      container.innerHTML = "";
      entryCount = 0;
      updateCount();
    });

    // Scroll to bottom
    scrollBtn.addEventListener("click", function () {
      container.scrollTop = container.scrollHeight;
      autoScroll = true;
      scrollBtn.classList.add("hidden");
    });

    // Auto-scroll detection
    container.addEventListener("scroll", function () {
      var atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 20;
      autoScroll = atBottom;
      if (atBottom) {
        scrollBtn.classList.add("hidden");
      } else {
        scrollBtn.classList.remove("hidden");
      }
    });

    // Filter listeners
    var levelChecks = document.querySelectorAll(".log-level-filter");
    for (var i = 0; i < levelChecks.length; i++) {
      levelChecks[i].addEventListener("change", onFilterChange);
    }
    componentSelect.addEventListener("change", onFilterChange);
    taskIdInput.addEventListener("input", onFilterChange);
    searchInput.addEventListener("input", onFilterChange);

    // Connect
    connect();
  });
})();
