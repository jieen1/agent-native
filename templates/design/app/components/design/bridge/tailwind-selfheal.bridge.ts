/**
 * Tailwind CDN self-heal bridge — injected into every canvas iframe.
 *
 * ALWAYS injected (cheap no-op when the prototype doesn't use the Tailwind
 * CDN build at all). Prototype screens load
 * `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4">`
 * directly in the sandboxed preview iframe. Under real editor load — many
 * screens' iframes booting at once alongside the rest of the app — that
 * script's own async compile step can silently get stuck and never produce
 * any output: no thrown error, no rejected promise, nothing in the console,
 * just zero Tailwind utility classes ever taking effect (every icon/size/
 * layout class renders at its raw default instead, e.g. an icon meant to be
 * 16px rendering at its full un-styled viewBox size). Re-running the exact
 * same script from scratch (a brand new <script> element, not touching the
 * stuck one) reliably produces the missing stylesheet, so once the page has
 * settled we verify Tailwind actually took effect and, if not, force a fresh
 * script load to self-heal instead of leaving the screen visibly broken.
 *
 * Detection: `.hidden` is a base Tailwind utility present in effectively
 * every real-world Tailwind stylesheet regardless of theme customization, so
 * a probe element's computed `display` is a reliable, config-independent
 * signal — unlike checking for a specific compiled rule or class name.
 *
 * Rules:
 *   • No import/require of any module (DOM globals only).
 *   • No references to outer/module scope (the code runs inside an iframe).
 *   • Wrap everything in a self-executing IIFE.
 */
(function () {
  var CHECK_DELAY_MS = 700;
  var RETRY_DELAY_MS = 1200;
  var MAX_ATTEMPTS = 3;

  function tailwindProducedOutput(): boolean {
    var probe = document.createElement("div");
    probe.className = "hidden";
    probe.style.position = "absolute";
    probe.style.top = "-9999px";
    probe.style.left = "-9999px";
    probe.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(probe);
    var applied = false;
    try {
      applied = window.getComputedStyle(probe).display === "none";
    } catch (_err) {}
    try {
      probe.remove();
    } catch (_err) {}
    return applied;
  }

  function reloadTailwindScripts(): boolean {
    var scripts = document.querySelectorAll(
      'script[src*="tailwindcss/browser"]',
    );
    if (scripts.length === 0) return false;
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].getAttribute("src");
      if (!src) continue;
      var fresh = document.createElement("script");
      fresh.src = src;
      document.head.appendChild(fresh);
    }
    return true;
  }

  function scheduleCheck(attempt: number): void {
    setTimeout(
      function () {
        if (tailwindProducedOutput()) return;
        var hasTailwindScript = !!document.querySelector(
          'script[src*="tailwindcss/browser"]',
        );
        if (!hasTailwindScript) return;
        if (attempt >= MAX_ATTEMPTS) return;
        if (reloadTailwindScripts()) scheduleCheck(attempt + 1);
      },
      attempt === 0 ? CHECK_DELAY_MS : RETRY_DELAY_MS,
    );
  }

  function start(): void {
    scheduleCheck(0);
  }

  if (document.readyState === "complete") {
    start();
  } else {
    window.addEventListener("load", start);
  }
})();
