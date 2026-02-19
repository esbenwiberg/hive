// htmx-ext.js — Toast system, slide-over panel, and HTMX event handlers
// Plain vanilla JS — no modules, no dependencies

(function () {
  "use strict";

  // ── Toast System ────────────────────────────────────────────────────────────

  var TOAST_DURATION = 4000; // ms before auto-dismiss
  var TOAST_FADE_DURATION = 300; // ms fade-out transition

  var toastColors = {
    success: {
      border: "border-l-4 border-emerald-400",
      icon: '<svg class="w-5 h-5 text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>',
    },
    error: {
      border: "border-l-4 border-red-400",
      icon: '<svg class="w-5 h-5 text-red-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" /></svg>',
    },
    info: {
      border: "border-l-4 border-blue-400",
      icon: '<svg class="w-5 h-5 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" /></svg>',
    },
  };

  function showToast(message, type) {
    var container = document.getElementById("toast-container");
    if (!container) return;

    type = type || "info";
    var colors = toastColors[type] || toastColors.info;

    var toast = document.createElement("div");
    toast.className =
      "flex items-center gap-3 rounded-lg bg-slate-800 px-4 py-3 shadow-lg ring-1 ring-slate-700 " +
      colors.border +
      " transform translate-y-4 opacity-0 transition-all duration-300 ease-out max-w-sm";

    toast.innerHTML =
      colors.icon +
      '<p class="text-sm text-slate-200">' +
      escapeText(message) +
      "</p>" +
      '<button class="ml-auto shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-200" aria-label="Dismiss">' +
      '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>' +
      "</button>";

    container.appendChild(toast);

    // Trigger slide-up animation on next frame
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.classList.remove("translate-y-4", "opacity-0");
        toast.classList.add("translate-y-0", "opacity-100");
      });
    });

    // Close button handler
    var closeBtn = toast.querySelector("button");
    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        dismissToast(toast);
      });
    }

    // Auto-dismiss
    setTimeout(function () {
      dismissToast(toast);
    }, TOAST_DURATION);
  }

  function dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.classList.add("opacity-0", "translate-y-4");
    toast.classList.remove("opacity-100", "translate-y-0");
    setTimeout(function () {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, TOAST_FADE_DURATION);
  }

  function escapeText(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  // ── Slide-over Panel ────────────────────────────────────────────────────────

  function openPanel() {
    var panel = document.getElementById("detail-panel");
    var backdrop = document.getElementById("panel-backdrop");
    if (!panel) return;

    // The detail-panel content is a fixed div injected by HTMX.
    // Show backdrop
    if (backdrop) {
      backdrop.classList.remove("hidden");
      requestAnimationFrame(function () {
        backdrop.classList.add("opacity-100");
        backdrop.classList.remove("opacity-0");
      });
    }

    // Animate in the child panel (the fixed div inside #detail-panel)
    var inner = panel.firstElementChild;
    if (inner) {
      inner.style.transform = "translateX(0)";
      inner.style.transition = "transform 200ms ease-out";
    }
  }

  function closePanel() {
    var panel = document.getElementById("detail-panel");
    var backdrop = document.getElementById("panel-backdrop");

    if (panel) {
      var inner = panel.firstElementChild;
      if (inner) {
        inner.style.transform = "translateX(100%)";
        inner.style.transition = "transform 200ms ease-in";
        setTimeout(function () {
          panel.innerHTML = "";
        }, 200);
      } else {
        panel.innerHTML = "";
      }
    }

    if (backdrop) {
      backdrop.classList.add("opacity-0");
      backdrop.classList.remove("opacity-100");
      setTimeout(function () {
        backdrop.classList.add("hidden");
      }, 200);
    }
  }

  // ── Clarification form submission ──────────────────────────────────────────

  function submitClarification(taskId, btn) {
    var form = document.getElementById("clarify-form-" + taskId);
    if (!form) return;

    var textareas = form.querySelectorAll("textarea[name='answers']");
    var answers = [];
    for (var i = 0; i < textareas.length; i++) {
      answers.push(textareas[i].value.trim());
    }

    // Require at least one non-empty answer
    if (answers.every(function (a) { return a === ""; })) {
      showToast("Please provide at least one answer", "error");
      return;
    }

    btn.disabled = true;
    btn.textContent = "Submitting…";

    fetch("/api/tasks/" + encodeURIComponent(taskId) + "/clarify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers: answers }),
    })
      .then(function (resp) {
        if (!resp.ok) return resp.text().then(function (body) { throw new Error(body || "HTTP " + resp.status); });
        return resp.text();
      })
      .then(function (html) {
        // Swap the task list like HTMX would
        var taskList = document.getElementById("task-list");
        if (taskList) taskList.innerHTML = html;
        showToast("Clarification answers submitted", "success");
        closePanel();
      })
      .catch(function (err) {
        showToast("Failed to submit: " + err.message, "error");
        btn.disabled = false;
        btn.textContent = "Submit Answers";
      });
  }

  // Expose globally for other scripts
  window.openPanel = openPanel;
  window.closePanel = closePanel;
  window.showToast = showToast;
  window.submitClarification = submitClarification;

  // ── Event Listeners ─────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", function () {
    // ── Listen for showToast from HTMX HX-Trigger header ───────────────────
    document.addEventListener("showToast", function (evt) {
      var detail = evt.detail || {};
      // HTMX 2.x sends HX-Trigger values in evt.detail
      // The structure can be { message: "...", type: "..." } or nested { value: { ... } }
      var message = detail.message || detail.value?.message || "Action completed";
      var type = detail.type || detail.value?.type || "info";
      showToast(message, type);
    });

    // ── HTMX error handler ─────────────────────────────────────────────────
    document.addEventListener("htmx:responseError", function (evt) {
      var detail = evt.detail || {};
      var xhr = detail.xhr;
      var status = xhr ? xhr.status : "Unknown";
      var statusText = xhr ? xhr.statusText : "Error";
      showToast("Error " + status + ": " + statusText, "error");
    });

    // ── Auto-open panel on HTMX swap into #detail-panel ────────────────────
    document.addEventListener("htmx:afterSwap", function (evt) {
      var target = evt.detail ? evt.detail.target : evt.target;
      if (target && target.id === "detail-panel" && target.innerHTML.trim() !== "") {
        openPanel();
      }
    });

    // ── Close panel on Escape ──────────────────────────────────────────────
    document.addEventListener("keydown", function (evt) {
      if (evt.key === "Escape") {
        var panel = document.getElementById("detail-panel");
        if (panel && panel.innerHTML.trim() !== "") {
          closePanel();
          evt.preventDefault();
          return;
        }

        // Also close create-panel
        var createPanel = document.getElementById("create-panel");
        if (createPanel && !createPanel.classList.contains("translate-x-full")) {
          createPanel.classList.add("translate-x-full");
          evt.preventDefault();
          return;
        }
      }
    });

    // ── Close on backdrop click ────────────────────────────────────────────
    var backdrop = document.getElementById("panel-backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", function () {
        closePanel();
      });
    }
  });
})();
