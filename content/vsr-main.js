/**
 * Codec preference for hardware decode (v2.0.2) — MAIN world, document_start.
 *
 * The second reason RTX Video never engages on a site: the stream is VP9 or
 * AV1 and the machine ends up decoding it in software. A software-decoded
 * frame is produced by the CPU into a normal texture, so there is no hardware
 * video surface for the driver to enhance — VSR has nothing to hook into.
 * (AV1 decode needs RTX 30-series or newer at all; VP9 support varies by GPU
 * and by what the browser decides to use.)
 *
 * H.264 is the one codec every GPU of the last decade decodes in hardware, so
 * telling the page "I cannot play VP9/AV1" makes adaptive players serve H.264,
 * which lands on the hardware path. This is the long-standing "h264ify"
 * technique, scoped here to a single opt-in setting.
 *
 * The trade-off is real and stated in the UI: sites that only publish 1440p/4K
 * in VP9/AV1 (YouTube among them) will cap at 1080p. For RTX VSR that is
 * usually the point — its input ceiling is 1440p and 1080p→4K is exactly the
 * case it was built for.
 *
 * Everything is a transparent pass-through: unknown types go to the original
 * implementation untouched.
 */
'use strict';
(() => {
  if (window.__gxtVsrCodec) return;
  window.__gxtVsrCodec = true;

  const BLOCKED = /vp0?[89]|vp9|av01|av1/i;

  try {
    for (const Source of [window.MediaSource, window.ManagedMediaSource, window.WebKitMediaSource]) {
      if (!Source || typeof Source.isTypeSupported !== 'function') continue;
      const original = Source.isTypeSupported.bind(Source);
      Source.isTypeSupported = function (type) {
        if (typeof type === 'string' && BLOCKED.test(type)) return false;
        return original(type);
      };
    }
  } catch {
    /* never break the page */
  }

  try {
    const proto = HTMLMediaElement.prototype;
    const original = proto.canPlayType;
    proto.canPlayType = function (type) {
      if (typeof type === 'string' && BLOCKED.test(type)) return '';
      return original.call(this, type);
    };
  } catch {
    /* ignore */
  }

  try {
    const caps = navigator.mediaCapabilities;
    if (caps && typeof caps.decodingInfo === 'function') {
      const original = caps.decodingInfo.bind(caps);
      caps.decodingInfo = async function (config) {
        const type = config?.video?.contentType || '';
        if (typeof type === 'string' && BLOCKED.test(type)) {
          return { supported: false, smooth: false, powerEfficient: false };
        }
        return original(config);
      };
    }
  } catch {
    /* ignore */
  }
})();
