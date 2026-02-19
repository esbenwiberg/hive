// commands.js — Command palette, keyboard shortcuts, and shortcuts help overlay
// Plain vanilla JS — no modules, no dependencies

(function () {
  "use strict";

  // ── State ───────────────────────────────────────────────────────────────────

  var focusedRowIndex = -1;
  var paletteOpen = false;
  var helpOpen = false;
  var paletteEl = null;
  var helpEl = null;
  var highlightClass = ["ring-2", "ring-amber-400/50", "bg-slate-800/80"];

  // ── Navigation Commands ─────────────────────────────────────────────────────

  var NAV_COMMANDS = [
    { label: "Dashboard", description: "Go to dashboard", href: "/", section: "Navigation" },
    { label: "Tasks", description: "Go to tasks", href: "/tasks", section: "Navigation" },
    { label: "Costs", description: "Go to costs", href: "/costs", section: "Navigation" },
    { label: "Producers", description: "Go to producers", href: "/producers", section: "Navigation" },
    { label: "Hivemind", description: "Go to hivemind", href: "/hivemind", section: "Navigation" },
    { label: "Settings", description: "Go to settings", href: "/settings", section: "Navigation" },
    { label: "Logs", description: "View live system logs", href: "/logs", section: "Navigation" },
    { label: "Profile", description: "Go to profile", href: "/profile", section: "Navigation" },
    { label: "New Task", description: "Create a new task", action: "newTask", section: "Actions" },
  ];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function isInputFocused() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = el.tagName.toUpperCase();
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      el.isContentEditable
    );
  }

  function getTaskRows() {
    return Array.prototype.slice.call(
      document.querySelectorAll("[data-task-row]")
    );
  }

  function clearRowHighlight() {
    var rows = getTaskRows();
    for (var i = 0; i < rows.length; i++) {
      for (var c = 0; c < highlightClass.length; c++) {
        rows[i].classList.remove(highlightClass[c]);
      }
    }
  }

  function highlightRow(index) {
    var rows = getTaskRows();
    if (index < 0 || index >= rows.length) return;
    clearRowHighlight();
    for (var c = 0; c < highlightClass.length; c++) {
      rows[index].classList.add(highlightClass[c]);
    }
    // Scroll into view if needed
    rows[index].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function escapeTextForHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ── New Task Action ─────────────────────────────────────────────────────────

  function openNewTask() {
    var createPanel = document.getElementById("create-panel");
    if (createPanel) {
      createPanel.classList.remove("translate-x-full");
      // Focus the title input
      var titleInput = createPanel.querySelector('input[name="title"]');
      if (titleInput) {
        setTimeout(function () {
          titleInput.focus();
        }, 250);
      }
    } else {
      // If not on tasks page, navigate there
      window.location.href = "/tasks";
    }
  }

  // ── Command Palette ─────────────────────────────────────────────────────────

  var paletteHighlightIndex = 0;
  var filteredCommands = [];
  var searchDebounceTimer = null;

  function createPalette() {
    if (paletteEl) return paletteEl;

    paletteEl = document.createElement("div");
    paletteEl.id = "command-palette";
    paletteEl.className =
      "fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] hidden";
    paletteEl.innerHTML =
      // Backdrop
      '<div id="palette-backdrop" class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>' +
      // Palette box
      '<div class="relative z-10 w-full max-w-lg rounded-xl border border-slate-700 bg-slate-800 shadow-2xl overflow-hidden">' +
      // Search input area
      '<div class="flex items-center gap-3 border-b border-slate-700 px-4 py-3">' +
      '<svg class="w-5 h-5 text-slate-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>' +
      '<input id="palette-input" type="text" placeholder="Type a command or search..." class="flex-1 bg-transparent text-sm text-slate-50 placeholder-slate-500 outline-none" autocomplete="off" />' +
      '<kbd class="hidden sm:inline-flex items-center rounded bg-slate-700 px-1.5 py-0.5 text-xs text-slate-400">Esc</kbd>' +
      "</div>" +
      // Results list
      '<div id="palette-results" class="max-h-72 overflow-y-auto py-2"></div>' +
      // Footer
      '<div class="border-t border-slate-700 px-4 py-2 flex items-center gap-4 text-xs text-slate-500">' +
      '<span><kbd class="rounded bg-slate-700 px-1 py-0.5 text-slate-400">&uarr;&darr;</kbd> Navigate</span>' +
      '<span><kbd class="rounded bg-slate-700 px-1 py-0.5 text-slate-400">Enter</kbd> Select</span>' +
      '<span><kbd class="rounded bg-slate-700 px-1 py-0.5 text-slate-400">Esc</kbd> Close</span>' +
      "</div>" +
      "</div>";

    document.body.appendChild(paletteEl);

    // Backdrop click to close
    var backdropEl = document.getElementById("palette-backdrop");
    if (backdropEl) {
      backdropEl.addEventListener("click", function () {
        closePalette();
      });
    }

    // Input event
    var input = document.getElementById("palette-input");
    if (input) {
      input.addEventListener("input", function () {
        var query = input.value;
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(function () {
          updatePaletteResults(query);
        }, 100);
      });

      input.addEventListener("keydown", function (evt) {
        if (evt.key === "ArrowDown") {
          evt.preventDefault();
          paletteHighlightIndex = Math.min(
            paletteHighlightIndex + 1,
            filteredCommands.length - 1
          );
          renderPaletteHighlight();
        } else if (evt.key === "ArrowUp") {
          evt.preventDefault();
          paletteHighlightIndex = Math.max(paletteHighlightIndex - 1, 0);
          renderPaletteHighlight();
        } else if (evt.key === "Enter") {
          evt.preventDefault();
          selectPaletteItem(paletteHighlightIndex);
        } else if (evt.key === "Escape") {
          evt.preventDefault();
          closePalette();
        }
      });
    }

    return paletteEl;
  }

  function openPalette() {
    var el = createPalette();
    el.classList.remove("hidden");
    paletteOpen = true;
    paletteHighlightIndex = 0;

    var input = document.getElementById("palette-input");
    if (input) {
      input.value = "";
      input.focus();
    }

    updatePaletteResults("");
  }

  function closePalette() {
    if (paletteEl) {
      paletteEl.classList.add("hidden");
    }
    paletteOpen = false;
    paletteHighlightIndex = 0;
  }

  function updatePaletteResults(query) {
    var resultsEl = document.getElementById("palette-results");
    if (!resultsEl) return;

    var q = (query || "").toLowerCase().trim();

    // Filter commands
    filteredCommands = [];
    for (var i = 0; i < NAV_COMMANDS.length; i++) {
      var cmd = NAV_COMMANDS[i];
      if (
        !q ||
        cmd.label.toLowerCase().indexOf(q) !== -1 ||
        cmd.description.toLowerCase().indexOf(q) !== -1
      ) {
        filteredCommands.push(cmd);
      }
    }

    // If on tasks page and there's a search query, add a task search option
    if (q && window.location.pathname.indexOf("/tasks") !== -1) {
      filteredCommands.push({
        label: 'Search tasks: "' + query + '"',
        description: "Search tasks by title",
        action: "searchTasks",
        searchQuery: query,
        section: "Search",
      });
    }

    paletteHighlightIndex = 0;
    renderPaletteResults(resultsEl);
  }

  function renderPaletteResults(resultsEl) {
    if (!resultsEl) {
      resultsEl = document.getElementById("palette-results");
    }
    if (!resultsEl) return;

    if (filteredCommands.length === 0) {
      resultsEl.innerHTML =
        '<div class="px-4 py-6 text-center text-sm text-slate-500">No results found</div>';
      return;
    }

    var html = "";
    var currentSection = "";

    for (var i = 0; i < filteredCommands.length; i++) {
      var cmd = filteredCommands[i];

      // Section header
      if (cmd.section !== currentSection) {
        currentSection = cmd.section;
        html +=
          '<div class="px-4 pt-2 pb-1 text-xs font-medium uppercase tracking-wider text-slate-500">' +
          escapeTextForHtml(currentSection) +
          "</div>";
      }

      var isHighlighted = i === paletteHighlightIndex;
      var cls = isHighlighted
        ? "bg-slate-700/80 text-slate-50"
        : "text-slate-300 hover:bg-slate-700/50";

      html +=
        '<div class="palette-item flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors ' +
        cls +
        '" data-palette-index="' +
        i +
        '">' +
        '<span class="text-sm font-medium">' +
        escapeTextForHtml(cmd.label) +
        "</span>" +
        '<span class="ml-auto text-xs text-slate-500">' +
        escapeTextForHtml(cmd.description) +
        "</span>" +
        "</div>";
    }

    resultsEl.innerHTML = html;

    // Click handlers on items
    var items = resultsEl.querySelectorAll(".palette-item");
    for (var j = 0; j < items.length; j++) {
      (function (idx) {
        items[idx].addEventListener("click", function () {
          selectPaletteItem(idx);
        });
        items[idx].addEventListener("mouseenter", function () {
          paletteHighlightIndex = idx;
          renderPaletteHighlight();
        });
      })(j);
    }
  }

  function renderPaletteHighlight() {
    var resultsEl = document.getElementById("palette-results");
    if (!resultsEl) return;

    var items = resultsEl.querySelectorAll(".palette-item");
    for (var i = 0; i < items.length; i++) {
      if (i === paletteHighlightIndex) {
        items[i].classList.add("bg-slate-700/80", "text-slate-50");
        items[i].classList.remove("text-slate-300");
        items[i].scrollIntoView({ block: "nearest" });
      } else {
        items[i].classList.remove("bg-slate-700/80", "text-slate-50");
        items[i].classList.add("text-slate-300");
      }
    }
  }

  function selectPaletteItem(index) {
    if (index < 0 || index >= filteredCommands.length) return;
    var cmd = filteredCommands[index];
    closePalette();

    if (cmd.href) {
      window.location.href = cmd.href;
    } else if (cmd.action === "newTask") {
      openNewTask();
    } else if (cmd.action === "searchTasks") {
      // Fetch filtered tasks via HTMX
      var taskList = document.getElementById("task-list");
      if (taskList && typeof htmx !== "undefined") {
        htmx.ajax("GET", "/api/tasks?search=" + encodeURIComponent(cmd.searchQuery), {
          target: "#task-list",
          swap: "innerHTML",
        });
      }
    }
  }

  // ── Shortcuts Help Overlay ──────────────────────────────────────────────────

  var shortcuts = [
    { keys: "Cmd+K / Ctrl+K", desc: "Open command palette" },
    { keys: "j / k", desc: "Move focus down / up through task rows" },
    { keys: "Enter", desc: "Open detail panel for focused row" },
    { keys: "a", desc: "Approve focused task" },
    { keys: "r", desc: "Reject focused task" },
    { keys: "n", desc: "Open new task form" },
    { keys: "Escape", desc: "Close any open panel or palette" },
    { keys: "?", desc: "Show this help overlay" },
  ];

  function createHelpOverlay() {
    if (helpEl) return helpEl;

    helpEl = document.createElement("div");
    helpEl.id = "shortcuts-help";
    helpEl.className =
      "fixed inset-0 z-[100] flex items-center justify-center hidden";

    var rows = "";
    for (var i = 0; i < shortcuts.length; i++) {
      var s = shortcuts[i];
      var keys = s.keys.split(" / ");
      var keysHtml = "";
      for (var k = 0; k < keys.length; k++) {
        if (k > 0) keysHtml += ' <span class="text-slate-500">/</span> ';
        keysHtml +=
          '<kbd class="inline-flex items-center rounded bg-slate-700 px-2 py-0.5 text-xs font-mono text-slate-300">' +
          escapeTextForHtml(keys[k].trim()) +
          "</kbd>";
      }
      rows +=
        '<div class="flex items-center justify-between py-2 ' +
        (i > 0 ? "border-t border-slate-700/50" : "") +
        '">' +
        '<span class="text-sm text-slate-300">' +
        escapeTextForHtml(s.desc) +
        "</span>" +
        '<span class="ml-4 flex items-center gap-1">' +
        keysHtml +
        "</span>" +
        "</div>";
    }

    helpEl.innerHTML =
      // Backdrop
      '<div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>' +
      // Modal
      '<div class="relative z-10 w-full max-w-md rounded-xl border border-slate-700 bg-slate-800 shadow-2xl p-6">' +
      '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-lg font-semibold text-slate-50">Keyboard Shortcuts</h3>' +
      '<button id="help-close-btn" class="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-slate-50">' +
      '<svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>' +
      "</button>" +
      "</div>" +
      '<div class="space-y-0">' +
      rows +
      "</div>" +
      "</div>";

    document.body.appendChild(helpEl);

    // Backdrop click to close
    helpEl.querySelector(".absolute").addEventListener("click", function () {
      closeHelp();
    });

    // Close button
    var closeBtn = document.getElementById("help-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        closeHelp();
      });
    }

    return helpEl;
  }

  function openHelp() {
    var el = createHelpOverlay();
    el.classList.remove("hidden");
    helpOpen = true;
  }

  function closeHelp() {
    if (helpEl) {
      helpEl.classList.add("hidden");
    }
    helpOpen = false;
  }

  // ── Keyboard Shortcuts ──────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("keydown", function (evt) {
      var key = evt.key;

      // ── Cmd+K / Ctrl+K — Command palette ───────────────────────────────
      if (key === "k" && (evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault();
        if (paletteOpen) {
          closePalette();
        } else {
          openPalette();
        }
        return;
      }

      // If palette is open, it handles its own keys via input listener
      if (paletteOpen) return;

      // ── Escape — Close help, panels ────────────────────────────────────
      if (key === "Escape") {
        if (helpOpen) {
          closeHelp();
          evt.preventDefault();
          return;
        }
        // Panel/palette close handled by htmx-ext.js escape handler
        return;
      }

      // Don't fire shortcuts when typing in an input
      if (isInputFocused()) return;

      // ── ? — Show shortcuts help ────────────────────────────────────────
      if (key === "?" || (key === "/" && evt.shiftKey)) {
        evt.preventDefault();
        if (helpOpen) {
          closeHelp();
        } else {
          openHelp();
        }
        return;
      }

      var rows = getTaskRows();

      // ── j — Move focus down ────────────────────────────────────────────
      if (key === "j") {
        evt.preventDefault();
        if (rows.length === 0) return;
        focusedRowIndex = Math.min(focusedRowIndex + 1, rows.length - 1);
        highlightRow(focusedRowIndex);
        return;
      }

      // ── k — Move focus up ─────────────────────────────────────────────
      if (key === "k") {
        evt.preventDefault();
        if (rows.length === 0) return;
        if (focusedRowIndex < 0) focusedRowIndex = 0;
        focusedRowIndex = Math.max(focusedRowIndex - 1, 0);
        highlightRow(focusedRowIndex);
        return;
      }

      // ── Enter — Open detail panel for focused row ─────────────────────
      if (key === "Enter") {
        if (focusedRowIndex >= 0 && focusedRowIndex < rows.length) {
          evt.preventDefault();
          var row = rows[focusedRowIndex];
          // Trigger HTMX request on the row (it has hx-get)
          if (typeof htmx !== "undefined") {
            htmx.trigger(row, "click");
          } else {
            row.click();
          }
        }
        return;
      }

      // ── a — Approve focused task ──────────────────────────────────────
      if (key === "a") {
        if (focusedRowIndex >= 0 && focusedRowIndex < rows.length) {
          evt.preventDefault();
          triggerRowAction(rows[focusedRowIndex], "approve");
        }
        return;
      }

      // ── r — Reject focused task ───────────────────────────────────────
      if (key === "r") {
        if (focusedRowIndex >= 0 && focusedRowIndex < rows.length) {
          evt.preventDefault();
          triggerRowAction(rows[focusedRowIndex], "reject");
        }
        return;
      }

      // ── n — Open new task form ────────────────────────────────────────
      if (key === "n") {
        evt.preventDefault();
        openNewTask();
        return;
      }
    });

    // ── Reset focus index on HTMX swap (task list may have changed) ────────
    document.addEventListener("htmx:afterSwap", function (evt) {
      var target = evt.detail ? evt.detail.target : evt.target;
      if (target && target.id === "task-list") {
        focusedRowIndex = -1;
        clearRowHighlight();
      }
    });
  });

  // ── Action Helper ───────────────────────────────────────────────────────────

  function triggerRowAction(row, actionName) {
    var taskId = row.getAttribute("data-task-id");
    if (!taskId) return;

    // Find the action button within the detail panel if open, or use hx-post directly
    var approveBtn = row.querySelector('[data-action="' + actionName + '"]');
    if (approveBtn) {
      approveBtn.click();
      return;
    }

    // Determine target status based on action
    var statusMap = {
      approve: "approved",
      reject: "rejected",
    };

    var targetStatus = statusMap[actionName];
    if (!targetStatus) return;

    // Direct HTMX POST to transition endpoint
    if (typeof htmx !== "undefined") {
      htmx.ajax("POST", "/api/tasks/" + taskId + "/transition", {
        target: "#task-list",
        swap: "innerHTML",
        values: { action: actionName, targetStatus: targetStatus },
      });
    }
  }
})();
