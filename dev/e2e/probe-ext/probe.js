/**
 * Isolated-world probe.
 *
 * This runs as a real content script in a real Chrome, i.e. in exactly the
 * execution world content/page-translate.js runs in. It sets up the three
 * candidate SPA-detection mechanisms, asks the PAGE to perform a pushState
 * navigation, and reports which of them actually observed it.
 *
 * The v2.7.0 audit claimed:
 *   - `history.pushState = patched` from here NEVER fires (isolated world);
 *   - `navigation`'s `navigatesuccess` DOES;
 *   - a location.href poll DOES.
 * Nothing below assumes any of that — it measures.
 */
'use strict';
(() => {
  const report = {
    world: 'isolated',
    href0: location.href,
    errors: [],
    // 1. Is the Navigation API even exposed to this world?
    navigationExists: typeof navigation,
    navigationHasAddEventListener: !!(typeof navigation !== 'undefined' && navigation && typeof navigation.addEventListener === 'function'),
    // 2. Did each mechanism observe a PAGE-initiated pushState?
    navigateSuccessFired: false,
    navigateFired: false,
    historyPatchFired: false,
    pollObserved: false,
    popstateFired: false,
    hashchangeFired: false,
    // 3. Timing: how long until each one knew.
    msToNavigateSuccess: null,
    msToPoll: null,
    // 4. Did the REAL extension load? Its web-accessible font proves it.
    realExtension: null,
  };

  window.addEventListener('error', (e) => report.errors.push(String(e.message)));

  // --- mechanism A: the Navigation API -------------------------------------
  try {
    if (typeof navigation !== 'undefined' && navigation?.addEventListener) {
      navigation.addEventListener('navigatesuccess', () => {
        if (!report.navigateSuccessFired) {
          report.navigateSuccessFired = true;
          report.msToNavigateSuccess = Date.now() - t0;
          report.hrefAtNavigateSuccess = location.href;
        }
      });
      navigation.addEventListener('navigate', () => { report.navigateFired = true; });
    }
  } catch (e) {
    report.errors.push('navigation: ' + e.message);
  }

  // --- mechanism B: the monkey-patch this project used to rely on ----------
  try {
    const original = history.pushState;
    history.pushState = function patched(...args) {
      report.historyPatchFired = true;
      return original.apply(this, args);
    };
    report.patchInstalled = history.pushState.name === 'patched';
  } catch (e) {
    report.errors.push('patch: ' + e.message);
  }

  // --- mechanism C: the poll ------------------------------------------------
  let lastUrl = location.href;
  const t0 = Date.now();
  const poll = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (!report.pollObserved) {
        report.pollObserved = true;
        report.msToPoll = Date.now() - t0;
      }
    }
  }, 1000);

  // --- controls -------------------------------------------------------------
  window.addEventListener('popstate', () => { report.popstateFired = true; });
  window.addEventListener('hashchange', () => { report.hashchangeFired = true; });

  // --- is the audited extension actually loaded? ---------------------------
  // Its manifest declares fonts/Vazirmatn-Regular.woff2 web-accessible to
  // http://*/*, so a successful fetch is proof the extension loaded AND that
  // its web_accessible_resources block is correct.
  async function checkRealExtension(ids) {
    for (const id of ids) {
      try {
        const url = `chrome-extension://${id}/fonts/Vazirmatn-Regular.woff2`;
        const res = await fetch(url);
        if (res.ok) {
          const buf = await res.arrayBuffer();
          const sig = new Uint8Array(buf.slice(0, 4));
          return {
            id,
            ok: true,
            bytes: buf.byteLength,
            // 'wOF2' — proves we got the real font, not an error page.
            woff2: String.fromCharCode(...sig) === 'wOF2',
          };
        }
      } catch {
        /* wrong id or not loaded */
      }
    }
    return { ok: false, tried: ids };
  }

  // Ask the PAGE to navigate. Going through the page is the whole point: a
  // pushState called from here would exercise our own patched copy and prove
  // nothing about what happens when a real SPA routes.
  const CANDIDATE_IDS = [new URL(location.href).searchParams.get('extension')].filter(Boolean);

  const start = () => {
    window.postMessage({ gxtProbe: 'pushState', to: '/route-b' }, '*');
    setTimeout(() => window.postMessage({ gxtProbe: 'pushState', to: '/route-c' }, '*'), 1200);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  // Report after the poll has had at least two chances to fire.
  setTimeout(async () => {
    clearInterval(poll);
    report.hrefEnd = location.href;
    report.realExtension = await checkRealExtension(CANDIDATE_IDS);
    try {
      await fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      });
    } catch (e) {
      document.title = 'REPORT FAILED ' + e.message;
    }
  }, 3400);
})();
