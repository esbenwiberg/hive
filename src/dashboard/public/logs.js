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
  var detailedMode = false;

  // Fields to hide from the detail panel (already shown in the log line)
  var HIDDEN_FIELDS = {
    level: 1, time: 1, msg: 1, pid: 1, hostname: 1, taskId: 1, raw: 1,
    v: 1, name: 1,
  };

  // ── DOM refs ───────────────────────────────────────────────────────────────

  var container, statusDot, statusText, pauseBtn, clearBtn, countEl,
    scrollBtn, componentSelect, taskIdInput, searchInput, detailedBtn;

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

  // ── Detail extraction ──────────────────────────────────────────────────────

  function extractDetails(entry) {
    var raw;
    try {
      raw = typeof entry.raw === "string" ? JSON.parse(entry.raw) : entry.raw;
    } catch (_e) {
      return null;
    }
    if (!raw || typeof raw !== "object") return null;

    var extras = {};
    var hasAny = false;
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      if (HIDDEN_FIELDS[key]) continue;
      extras[key] = raw[key];
      hasAny = true;
    }
    return hasAny ? extras : null;
  }

  function renderDetailPanel(extras) {
    var panel = document.createElement("div");
    panel.className = "log-detail-panel ml-16 mb-1 rounded border border-slate-700 bg-slate-900/80 px-3 py-2 text-[11px] leading-relaxed";

    var html = '<table class="w-full">';
    for (var key in extras) {
      if (!Object.prototype.hasOwnProperty.call(extras, key)) continue;
      var val = extras[key];
      var display = typeof val === "object" ? JSON.stringify(val, null, 2) : String(val);
      var valClass = "text-slate-300";
      // Color-code HTTP status codes
      if (key === "status" && typeof val === "number") {
        if (val >= 200 && val < 300) valClass = "text-emerald-400";
        else if (val >= 400 && val < 500) valClass = "text-amber-400";
        else if (val >= 500) valClass = "text-red-400";
      }
      var isMultiline = typeof val === "object" || (typeof display === "string" && display.length > 100);
      html += '<tr class="align-top">' +
        '<td class="pr-3 py-0.5 text-slate-500 whitespace-nowrap font-medium">' + esc(key) + '</td>' +
        '<td class="py-0.5 ' + valClass + (isMultiline ? ' whitespace-pre-wrap break-all' : '') + '">' + esc(display) + '</td>' +
        '</tr>';
    }
    html += '</table>';
    panel.innerHTML = html;
    return panel;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function renderEntry(entry) {
    var wrapper = document.createElement("div");
    wrapper.className = "log-entry";

    var line = document.createElement("div");
    line.className = "flex gap-2 py-0.5 hover:bg-slate-900/50 cursor-pointer select-none";

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

    var extras = extractDetails(entry);

    // Show a subtle indicator when extra fields exist
    var detailHint = extras
      ? '<span class="text-slate-600 shrink-0 text-[10px] ml-auto" title="Click to expand details">&hellip;</span>'
      : '';

    line.innerHTML = time + level + comp + taskTag + msg + detailHint;
    wrapper.appendChild(line);

    if (entry.err) {
      var errEl = document.createElement("div");
      errEl.className = "ml-16 text-red-400/80 whitespace-pre-wrap py-0.5";
      errEl.textContent = entry.err;
      wrapper.appendChild(errEl);
    }

    // Detail panel (expandable)
    if (extras) {
      var panel = renderDetailPanel(extras);
      if (!detailedMode) {
        panel.style.display = "none";
      }
      wrapper.appendChild(panel);

      line.addEventListener("click", function () {
        var isHidden = panel.style.display === "none";
        panel.style.display = isHidden ? "" : "none";
        if (isHidden && autoScroll) {
          container.scrollTop = container.scrollHeight;
        }
      });
    }

    container.appendChild(wrapper);

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
    detailedBtn = document.getElementById("log-detailed");

    if (!container) return; // Not on the logs page

    // Detailed mode toggle
    detailedBtn.addEventListener("click", function () {
      detailedMode = !detailedMode;
      detailedBtn.textContent = detailedMode ? "Compact" : "Detailed";
      if (detailedMode) {
        detailedBtn.classList.add("border-amber-400/50", "text-amber-400");
        detailedBtn.classList.remove("border-slate-600", "text-slate-300");
      } else {
        detailedBtn.classList.remove("border-amber-400/50", "text-amber-400");
        detailedBtn.classList.add("border-slate-600", "text-slate-300");
      }
      // Toggle all existing detail panels
      var panels = container.querySelectorAll(".log-detail-panel");
      for (var i = 0; i < panels.length; i++) {
        panels[i].style.display = detailedMode ? "" : "none";
      }
      if (autoScroll) {
        container.scrollTop = container.scrollHeight;
      }
    });

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
