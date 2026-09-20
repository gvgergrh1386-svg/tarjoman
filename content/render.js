/**
 * Rendering layer: builds the translation UI so it reads as native X.
 *
 * Typography is copied from the source tweet-text element at insert time
 * (font, size, color), links/mentions/emojis are *clones of X's own nodes*
 * so they keep X's exact styling and hrefs, and every piece of chrome is
 * theme-agnostic (colors derive from currentColor, so light/dark/dim all
 * work with no theme detection).
 */
'use strict';
(() => {
  globalThis.GXT = globalThis.GXT || {};

  const LANG_NAMES = {
    get en() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_34"); }, get ja() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_33"); }, get ko() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_32"); }, get zh() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_31"); }, get ar() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_30"); },
    get ru() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_29"); }, get es() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_28"); }, get fr() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_27"); }, get de() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_26"); }, get tr() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_25"); },
    get az() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_24"); }, get hi() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_23"); }, get ur() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_22"); }, get pt() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_21"); },
    get it() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_20"); }, get nl() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_19"); }, get id() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_18"); }, get th() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_17"); },
    get vi() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_16"); }, get pl() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_15"); }, get uk() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_14"); }, get sv() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_13"); },
    get fi() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_12"); }, get he() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_11"); }, get el() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_10"); }, get cs() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_9"); }, get ro() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_8"); },
    get hu() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_7"); }, get da() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_6"); }, get no() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_5"); }, get ms() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_4"); }, get tl() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_3"); },
    get bn() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_2"); }, get fa() { return globalThis.GXT.i18n.t("content_render_LANG_NAMES_1"); },
  };

  /**
   * Per-source-element UI state.
   * @type {WeakMap<Element, {box?: HTMLElement, link?: HTMLElement, hiddenOriginal?: boolean}>}
   */
  const stateMap = new WeakMap();

  function getState(el) {
    let state = stateMap.get(el);
    if (!state) {
      state = {};
      stateMap.set(el, state);
    }
    return state;
  }

  function hasUI(el) {
    const state = stateMap.get(el);
    return !!(state && ((state.box?.isConnected && el.nextElementSibling === state.box) ||
      (state.link?.isConnected && el.nextElementSibling === state.link)));
  }

  function needsRepair(el) {
    const state = stateMap.get(el);
    return !!(state && (state.box || state.link) && !hasUI(el));
  }

  /** True only when the element is showing a finished translation (a box with
   *  translated text) — not a loading skeleton, error, or manual link. Lets a
   *  live view-setting change (replaceOriginal) re-render exactly those. */
  function isTranslated(el) {
    const state = stateMap.get(el);
    return !!(hasUI(el) && state?.box?.querySelector('.gxt-text'));
  }

  function applyTypography(sourceEl, box) {
    const cs = getComputedStyle(sourceEl);
    // X's own font chain, exposed as a variable so the stylesheet can prefer
    // the user's chosen font (--gxt-font, set on :root by main.js) over it.
    box.style.setProperty('--gxt-x-font', cs.fontFamily);
    box.style.fontSize = cs.fontSize;
    box.style.color = cs.color;
    const lh = parseFloat(cs.lineHeight);
    if (Number.isFinite(lh)) {
      // Persian benefits from slightly looser leading than Latin.
      box.style.lineHeight = `${Math.round(lh * 1.2)}px`;
    }
  }

  // v2.0.0: the accent is the user's own choice from the appearance sheet
  // (main.js writes --gxt-accent onto :root), so the box no longer samples a
  // link's colour off the page. content.css falls back to X blue if unset.

  function wrapBdi(node) {
    const bdi = document.createElement('bdi');
    bdi.className = 'gxt-ltr';
    bdi.appendChild(node);
    return bdi;
  }

  function cloneEntity(node) {
    const clone = node.cloneNode(true);
    clone.removeAttribute?.('id');
    for (const child of clone.querySelectorAll?.('[id]') || []) child.removeAttribute('id');
    // X may style entities through ancestor selectors that no longer match
    // inside our box; pin the important computed styles onto the clone.
    if (node.isConnected) {
      try {
        const cs = getComputedStyle(node);
        if (node.tagName === 'A') {
          clone.style.color = cs.color;
        } else if (node.tagName === 'IMG') {
          clone.style.width = cs.width;
          clone.style.height = cs.height;
          clone.style.verticalAlign = cs.verticalAlign;
        }
      } catch {
        /* keep class-based styling */
      }
    }
    return clone;
  }

  /** Append a plain-text run, re-linkifying mentions/hashtags and emojis.
   *  Matching is case-insensitive (v1.8): a model that changes @Handle's
   *  capitalization no longer silently loses the clickable clone. */
  function appendRun(fragment, str, extraction) {
    if (!str) return;
    const matchers = [];
    for (const item of extraction.inline) {
      if (item.text) {
        matchers.push({
          find: item.text,
          lower: item.text.toLowerCase(),
          entity: true,
          make: () => wrapBdi(cloneEntity(item.node)),
        });
      }
    }
    for (const [alt, node] of extraction.emoji) {
      matchers.push({ find: alt, lower: alt.toLowerCase(), make: () => cloneEntity(node) });
    }
    matchers.sort((a, b) => b.find.length - a.find.length);

    // Lowercasing may change length for a few locales (İ → i̇); when it does,
    // indices no longer line up — fall back to exact matching for safety.
    const folded = str.toLowerCase();
    const useFolded = folded.length === str.length;
    let buffer = '';
    let i = 0;
    while (i < str.length) {
      let hit = null;
      for (const matcher of matchers) {
        const foldable = useFolded && matcher.lower.length === matcher.find.length;
        const matched = foldable
          ? folded.startsWith(matcher.lower, i)
          : str.startsWith(matcher.find, i);
        const before = i > 0 ? str[i - 1] : '';
        const after = str[i + matcher.find.length] || '';
        const boundary = !matcher.entity ||
          (!/[\p{L}\p{N}_@#$]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after));
        if (matched && boundary) {
          hit = matcher;
          break;
        }
      }
      if (hit) {
        if (buffer) {
          fragment.append(buffer);
          buffer = '';
        }
        fragment.appendChild(hit.make());
        i += hit.find.length;
      } else {
        buffer += str[i];
        i += 1;
      }
    }
    if (buffer) fragment.append(buffer);
  }

  /** Rebuild rich content: ⟦n⟧ tokens become clones of the original links. */
  function renderRich(target, translated, extraction) {
    const fragment = document.createDocumentFragment();
    const tokenRe = /⟦(\d+)⟧/g;
    const used = new Set();
    let last = 0;
    let match;
    while ((match = tokenRe.exec(translated)) !== null) {
      appendRun(fragment, translated.slice(last, match.index), extraction);
      const placeholder = extraction.placeholders.find((p) => p.token === match[0]);
      if (placeholder) {
        fragment.appendChild(wrapBdi(cloneEntity(placeholder.node)));
        used.add(match[0]);
      } else {
        // Literal/model-created tokens without a source link are still text.
        fragment.append(match[0]);
      }
      last = match.index + match[0].length;
    }
    appendRun(fragment, translated.slice(last), extraction);
    // Never lose a link: anything the model dropped is appended at the end.
    for (const placeholder of extraction.placeholders) {
      if (!used.has(placeholder.token)) {
        fragment.append(' ');
        fragment.appendChild(wrapBdi(cloneEntity(placeholder.node)));
      }
    }
    target.replaceChildren(fragment);
  }

  function ensureBox(el) {
    const state = getState(el);
    if (state.box && state.box.isConnected) {
      if (el.nextElementSibling !== state.box) el.insertAdjacentElement('afterend', state.box);
      return state.box;
    }
    const box = document.createElement('div');
    box.className = 'gxt-box';
    box.dir = globalThis.GXT.i18n.direction();
    // v2.9.5 — WCAG 3.1.2. Without this the box is Persian sitting inside
    // x.com's `lang="en"`, so a screen reader reads it with an English voice
    // and the translation is unintelligible to the person who needed it most.
    box.lang = globalThis.GXT.i18n.language();
    applyTypography(el, box);
    el.insertAdjacentElement('afterend', box);
    state.box = box;
    return box;
  }

  function removeLink(el) {
    const state = getState(el);
    if (state.link) {
      state.link.remove();
      state.link = null;
    }
  }

  function restoreOriginal(el) {
    const state = getState(el);
    if (state.hiddenOriginal) {
      if (state.originalDisplay) {
        el.style.setProperty('display', state.originalDisplay, state.originalDisplayPriority);
      } else el.style.removeProperty('display');
      state.hiddenOriginal = false;
    }
  }

  function hideOriginal(el) {
    const state = getState(el);
    if (state.hiddenOriginal) return;
    state.originalDisplay = el.style.getPropertyValue('display');
    state.originalDisplayPriority = el.style.getPropertyPriority('display');
    el.style.setProperty('display', 'none', 'important');
    state.hiddenOriginal = true;
  }

  function removeUI(el) {
    const state = getState(el);
    if (state.box) {
      state.box.remove();
      state.box = null;
    }
    removeLink(el);
    restoreOriginal(el);
  }

  function showTranslateLink(el, onClick, label = globalThis.GXT.i18n.t("content_main_linkLabel_1")) {
    const state = getState(el);
    if (state.box) {
      state.box.remove();
      state.box = null;
    }
    restoreOriginal(el);
    if (state.link && state.link.isConnected) return;
    const row = document.createElement('div');
    row.className = 'gxt-linkrow';
    row.dir = globalThis.GXT.i18n.direction();
    const link = document.createElement('span');
    link.className = 'gxt-link';
    link.setAttribute('role', 'button');
    link.tabIndex = 0;
    globalThis.GXT.i18n.bindLabel(link,'textContent',label);
    activatable(link, onClick);
    row.appendChild(link);
    el.insertAdjacentElement('afterend', row);
    state.link = row;
  }

  function showLoading(el) {
    removeLink(el);
    restoreOriginal(el);
    const box = ensureBox(el);
    box.lang = globalThis.GXT.i18n.language(); box.dir = globalThis.GXT.i18n.direction();
    box.replaceChildren();
    const skeletonWide = document.createElement('div');
    skeletonWide.className = 'gxt-skel';
    skeletonWide.style.width = '86%';
    const skeletonNarrow = document.createElement('div');
    skeletonNarrow.className = 'gxt-skel';
    skeletonNarrow.style.width = '55%';
    box.append(skeletonWide, skeletonNarrow);
  }

  /**
   * Make a `role="button"` span behave like a button.
   *
   * A real <button> would be simpler, but X's timeline styles form controls
   * aggressively and one inside a post looks wrong. The cost of a span is that
   * `role` + `tabIndex` only PROMISE a button — the browser gives such an
   * element no keyboard activation of its own. Every control built here was
   * therefore focusable and impossible to press without a mouse: a keyboard or
   * screen-reader user could tab onto «نهفتن», «تلاش دوباره» or 🔊 and nothing
   * would happen. Enter and Space are what a button owes them.
   */
  function activatable(el, onActivate) {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onActivate();
    });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      // Space scrolls the page and Enter can submit a surrounding form; a
      // control that consumed the key must not also do that.
      event.preventDefault();
      event.stopPropagation();
      onActivate();
    });
    return el;
  }

  function headButton(text, onClick) {
    const button = document.createElement('span');
    button.className = 'gxt-btn';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    globalThis.GXT.i18n.bindLabel(button,'textContent',text);
    return activatable(button, onClick);
  }

  function showTranslation(
    el,
    translated,
    extraction,
    srcLang,
    { replaceOriginal = false, engine = 'Gemini', tts = false, refreshOptions = null, targetLang = 'fa' } = {}
  ) {
    removeLink(el);
    const state = getState(el);
    const box = ensureBox(el);
    box.lang = targetLang; box.dir = globalThis.GXT.targetDirection(targetLang);
    box.replaceChildren();
    box.classList.add('gxt-fade');

    const head = document.createElement('div');
    head.className = 'gxt-head';
    const label = document.createElement('span');
    label.className = 'gxt-label';
    const langName = () => LANG_NAMES[srcLang] || (srcLang ? globalThis.GXT.targetName(srcLang,globalThis.GXT.i18n.language()) : '');
    globalThis.GXT.i18n.bind(label, "textContent", () => (langName() ? globalThis.GXT.i18n.t("content_render_showTranslation_4", {v0:(langName()), v1:(engine)}) : globalThis.GXT.i18n.t("content_render_showTranslation_3", {v0:(engine)})));
    head.appendChild(label);

    if (replaceOriginal) {
      if (!state.hiddenOriginal) {
        hideOriginal(el);
      }
      const toggle = headButton(globalThis.GXT.i18n.t("content_render_toggle_1"), () => {
        if (state.hiddenOriginal) {
          restoreOriginal(el);
          globalThis.GXT.i18n.bind(toggle, "textContent", () => (globalThis.GXT.i18n.t("content_render_toggle_2")));
        } else {
          hideOriginal(el);
          globalThis.GXT.i18n.bind(toggle, "textContent", () => (globalThis.GXT.i18n.t("content_render_toggle_1")));
        }
      });
      head.appendChild(toggle);
    } else if (state.hiddenOriginal) {
      // A live toggle of replaceOriginal re-invokes showTranslation with the
      // new value; when it is now OFF, un-hide an original hidden by a prior
      // render so the change actually takes effect on already-translated posts.
      restoreOriginal(el);
    }

    head.appendChild(
      headButton(globalThis.GXT.i18n.t("content_render_showTranslation_2"), () => {
        // Detach but keep the built box so re-showing costs nothing.
        box.remove();
        state.box = null;
        restoreOriginal(el);
        showTranslateLink(el, () => {
          // Settings may change while the translation is hidden. Rebuilding
          // this local box is free and applies the current original/TTS choice.
          showTranslation(el, translated, extraction, srcLang,
            refreshOptions?.() || { replaceOriginal, engine, tts });
        }, globalThis.GXT.i18n.t("content_render_showTranslation_1"));
      })
    );

    const body = document.createElement('div');
    body.className = 'gxt-text';
    renderRich(body, translated, extraction);

    // Read-aloud (v2.2.0). Built here rather than reused from ui.js because
    // this box lives in the PAGE's DOM with X's own styling, not in the shared
    // shadow root — only the playback engine is shared.
    if (tts && globalThis.GXT?.ui?.speak) {
      let playing = false;
      const speaker = headButton('🔊', () => {
        if (playing) {
          globalThis.GXT.ui.stopSpeech();
          paint('idle');
          return;
        }
        globalThis.GXT.ui.speak(body.textContent || '', {
          onState: (state, info) => {
            paint(state);
            if (state === 'error') globalThis.GXT.ui.toast(globalThis.GXT.ui.friendly(info));
          },
        });
      });
      const paint = (state) => {
        playing = state === 'loading' || state === 'playing';
        speaker.textContent = state === 'loading' ? '…' : playing ? '■' : '🔊';
        globalThis.GXT.i18n.bind(speaker, "title", () => (playing ? globalThis.GXT.i18n.t("content_render_paint_2") : globalThis.GXT.i18n.t("content_render_paint_1")));
        // An emoji is not a label: a screen reader reads 🔊 as "speaker high
        // volume" and ■ as "black square", neither of which says what the
        // control does.
        speaker.setAttribute('aria-label', speaker.title);
        speaker.setAttribute('aria-pressed', playing ? 'true' : 'false');
      };
      paint('idle');
      head.appendChild(speaker);
    }

    box.append(head, body);
  }

  /**
   * Render error diagnostics — provider, model, per-key attempts, HTTP status,
   * API status strings, quota ids and raw messages. Nothing is hidden except
   * the credential itself.
   *
   * This box lives in X's OWN DOM, which X's own scripts can read. The worker
   * already masks keys before sending them here (errorDetail); masking again on
   * the way out costs nothing and means a key cannot reach the page even if a
   * future code path forgets. The full key stays available in the popup, which
   * runs on the extension's origin.
   */
  const mask = (key) => globalThis.GXT?.maskKey?.(key) ?? '***';
  const clean = (text) => globalThis.GXT?.scrubSecrets?.(text) ?? String(text ?? '');

  function formatDetail(d) {
    if (!d) return '';
    const lines = [];
    lines.push(
      `provider=${d.provider}  model=${d.model}  code=${d.code}` +
        (d.http ? `  http=${d.http}` : '') +
        (d.apiStatus ? `  status=${d.apiStatus}` : '')
    );
    if (d.quotaId) lines.push(`quota=${d.quotaId}`);
    if (d.retryAfterMs) lines.push(`retryAfter=${Math.round(d.retryAfterMs / 1000)}s`);
    if (d.raw) lines.push(`message=${clean(d.raw)}`);
    for (const a of d.attempts || []) {
      if (a.code === 'COOLING' || a.code === 'INVALID') {
        const left = Math.max(0, Math.round(((a.coolUntil || 0) - Date.now()) / 1000));
        lines.push(`key ${mask(a.key)} -> skipped (${a.code}${a.coolUntil ? ` ${left}s left` : ''})`);
      } else {
        lines.push(
          `key ${mask(a.key)} -> ${a.code}` +
            (a.http ? ` HTTP ${a.http}` : '') +
            (a.apiStatus ? ` ${a.apiStatus}` : '') +
            (a.retryAfterMs ? ` retry=${Math.round(a.retryAfterMs / 1000)}s` : '') +
            (a.quotaId ? `\n  quota=${a.quotaId}` : '') +
            (a.raw ? `\n  msg=${clean(a.raw)}` : '')
        );
      }
    }
    return lines.join('\n');
  }

  function showError(el, message, onRetry, detail) {
    removeLink(el);
    restoreOriginal(el);
    const box = ensureBox(el);
    box.lang = globalThis.GXT.i18n.language(); box.dir = globalThis.GXT.i18n.direction();
    box.replaceChildren();
    const row = document.createElement('div');
    row.className = 'gxt-err';
    row.append(message + ' ');
    const retry = document.createElement('span');
    retry.className = 'gxt-retry';
    retry.setAttribute('role', 'button');
    retry.tabIndex = 0;
    globalThis.GXT.i18n.bind(retry, "textContent", () => (globalThis.GXT.i18n.t("content_render_showError_3")));
    activatable(retry, onRetry);
    row.appendChild(retry);
    box.appendChild(row);

    const detailText = formatDetail(detail);
    if (detailText) {
      const toggle = document.createElement('span');
      toggle.className = 'gxt-btn gxt-detail-btn';
      toggle.setAttribute('role', 'button');
      toggle.tabIndex = 0;
      globalThis.GXT.i18n.bind(toggle, "textContent", () => (globalThis.GXT.i18n.t("content_render_showError_2")));
      const pre = document.createElement('pre');
      pre.className = 'gxt-detail';
      pre.dir = 'ltr';
      pre.textContent = detailText;
      pre.style.display = 'none';
      toggle.setAttribute('aria-expanded', 'false');
      activatable(toggle, () => {
        const open = pre.style.display !== 'none';
        pre.style.display = open ? 'none' : 'block';
        toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
        globalThis.GXT.i18n.bind(toggle, "textContent", () => (open ? globalThis.GXT.i18n.t("content_render_showError_2") : globalThis.GXT.i18n.t("content_render_showError_1")));
      });
      row.append(' ');
      row.appendChild(toggle);
      box.appendChild(pre);
    }
  }

  let toastEl = null;
  let toastTimer = null;

  /**
   * One toast in the product — v3.2.5.
   *
   * This was a second, independent toast implementation: a fixed near-black box
   * in the page's own DOM, while content/ui.js has a themed one in the shared
   * shadow root. So the same kind of message looked like the extension on every
   * site except X, which is the site the extension is most used on. The shared
   * layer is in the manifest for x.com, so it is present in practice and this
   * always delegates; the local box survives only as the no-shared-layer
   * fallback (and content.css puts it on the tokens too, so even that path is
   * not a visible downgrade).
   */
  function toast(message) {
    const shared = globalThis.GXT?.ui?.toast;
    if (shared) return void shared(message, 6000);
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'gxt-toast';
      toastEl.dir = globalThis.GXT.i18n.direction();
      // A message the user cannot get any other way must be announced.
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add('gxt-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('gxt-toast-show'), 6000);
  }

  globalThis.GXT.render = {
    hasUI,
    needsRepair,
    isTranslated,
    showTranslateLink,
    showLoading,
    showTranslation,
    showError,
    removeUI,
    toast,
    _internal: { renderRich, appendRun, LANG_NAMES },
  };
})();
