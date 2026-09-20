'use strict';
(() => {
  const error = () => Object.assign(new Error(globalThis.GXT.i18n.t("background_abort_error_1")), { code: 'CANCELLED', retriable: false });
  const check = signal => { if (signal?.aborted) throw error(); };
  function link(signal, controller) {
    check(signal);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    return () => signal?.removeEventListener('abort', abort);
  }
  function wait(promise, signal) {
    if (!signal) return promise;
    // The provider may have created an already-rejecting promise immediately
    // before cancellation was observed (for example after an async key read).
    // Retiring the wait must still observe that promise's eventual rejection.
    const observed = Promise.resolve(promise);
    if (signal.aborted) { observed.catch(() => {}); throw error(); }
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(error()); };
      signal.addEventListener('abort', abort, { once: true });
      observed.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, reason => { signal.removeEventListener('abort', abort); reject(reason); });
    });
  }
  function sleep(ms, signal) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    check(signal);
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error()); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  globalThis.GXT.abort = { error, check, link, wait, sleep };
})();
