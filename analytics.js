/* Curl Moving — click-to-call / click-to-text / quote-form conversion tracking
 *
 * Conversions on this site are tel: and sms: link clicks plus quote-form
 * submissions. Without this file, Google Ads reports zero conversions while the
 * phone is ringing.
 *
 * Fires on every tel:/sms: link and every quote form, on every page, via
 * delegated listeners — so links and forms added later are covered
 * automatically with no code change.
 *
 * One exception to "fires on the element": the Ads lead conversion fires on the
 * /thanks/ landing instead of on submit, so it counts accepted leads and
 * survives the page teardown. See the block at the bottom of this file.
 *
 * ── ADS ACCOUNT: READ THIS BEFORE CHANGING AW_ID ─────────────────────────────
 * Until 2026-08-13 this site was tagged AW-878922638, inherited from the
 * WordPress build (see the archive, and commit 07b5cf9). That account has no
 * campaigns and never had a conversion action — grep the old site's source and
 * no send_to appears anywhere. So every conversion signal the site ever sent
 * went to an account that buys no ads.
 *
 * The account actually running campaigns is AW-11500888387. AW_ID and the
 * gtag('config', …) line on all 18 pages were repointed to it on 2026-08-13.
 * An Ads account has exactly one conversion ID, so a mismatch between AW_ID
 * and a pasted label is silent — the hit is accepted and attributed to
 * nothing. If conversions ever read zero while GA4 shows events, compare
 * AW_ID against the send_to in the Ads Tag setup panel first.
 *
 * ── TO FINISH SETUP ──────────────────────────────────────────────────────────
 * Two conversion actions, because calls and form leads must stay separable in
 * Ads: they are worth different amounts and are optimised for differently.
 *
 *   Ads > Goals > Conversions > + New conversion action > Website. The flow is
 *   one action at a time, and "manual" is required — automatic detection
 *   issues no label and would double-count events this file already fires.
 *
 *     1. "Curl Moving — Call/Text Click"  -> AW_LABEL_CALL   (category Contact)
 *     2. "Curl Moving — Quote Form"       -> AW_LABEL_LEAD   (Submit lead form)
 *
 *   The label is the part after the slash in the event snippet's
 *   send_to: 'AW-11500888387/XXXXXXXX'.
 *
 * With a label blank, that GA4 event still fires; only the native Ads
 * conversion is skipped. So a half-finished setup degrades quietly.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  var AW_ID = 'AW-11500888387';

  /* Two labels, deliberately. A single shared label would report every tel:/sms:
     click as a quote-form conversion and vice versa, making the two
     indistinguishable in Ads and unusable for bidding. */
  var AW_LABEL_CALL = 'woZzCOGwpuEcEMPChuwq'; // tel: and sms: clicks
  var AW_LABEL_LEAD = '5bwNCN6wpuEcEMPChuwq'; // quote-form submissions

  var GENERIC = ['section', 'grit', 'dark', 'container', 'wrap', 'inner'];

  function slug(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 40);
  }

  /* Last heading that appears before this link within its own section.
     Used when the wrapper has no distinguishing class of its own. */
  function nearestHeading(el, scope) {
    var hs = scope.querySelectorAll('h1,h2,h3'), best = '';
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        best = hs[i].textContent;
      }
    }
    return slug(best);
  }

  /* Which block on the page did the click come from?
     Derived from the DOM, so no markup changes are needed and links added
     later are labelled automatically. Order matters: hero is checked before
     cta because .hero-cta-row matches both. */
  function ctaSection(el) {
    if (el.closest('footer')) return 'footer';
    if (el.closest('header')) return 'header';
    if (el.closest('.card-actions')) return 'service-card';
    if (el.closest('[class*="hero"]')) return 'hero';
    if (el.closest('[class*="cta"]')) return 'cta-block';

    var scope = el.closest('section, main');
    if (scope) {
      if (scope.id) return slug(scope.id);
      var al = scope.getAttribute('aria-label');
      if (al) return slug(al);
      var cls = (scope.className || '').split(/\s+/).filter(function (c) {
        return c && GENERIC.indexOf(c) === -1;
      });
      if (cls.length) return slug(cls[0]);
      var h = nearestHeading(el, scope);
      if (h) return h;
    }
    return 'body';
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href^="tel:"], a[href^="sms:"]');
    if (!a) return;
    if (typeof window.gtag !== 'function') return;

    var href = a.getAttribute('href') || '';
    var isCall = href.lastIndexOf('tel:', 0) === 0;

    /* transport_type:'beacon' matters here — a tel:/sms: click hands the page
       off to the dialer, which can kill an in-flight XHR. Do NOT delay
       navigation with event_callback; it is unreliable on these links. */
    window.gtag('event', isCall ? 'click_to_call' : 'click_to_text', {
      cta_section: ctaSection(a),
      cta_label: (a.textContent || '').trim().slice(0, 60),
      page_path: window.location.pathname,
      /* sms: links carry a prefilled body, so href runs ~94 chars and GA4
         silently drops any parameter value over 100. Log the number only. */
      link_url: href.split('?')[0].slice(0, 100),
      transport_type: 'beacon'
    });

    if (AW_LABEL_CALL) {
      window.gtag('event', 'conversion', {
        send_to: AW_ID + '/' + AW_LABEL_CALL,
        transport_type: 'beacon'
      });
    }
  }, true); // capture phase: run before the browser hands off to the dialer

  /* Quote form submissions — GA4 only. The form does a native POST to the
     Cloudflare Worker at /api/quote, which answers 303 to /thanks/, so the page
     is torn down moments after submit. transport_type 'beacon' is a GA4
     transport hint and GA4 honours it, so this event survives the teardown.
     Never block submit on a callback.

     This counts ATTEMPTS: a submission the Worker rejects (400 missing
     name/phone, 403 outside US/HN, 400 Turnstile) still fires it. That is
     deliberate — the attempt rate is worth seeing on its own.

     The Ads lead conversion is NOT fired here; see the /thanks/ block below. */
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    if (!f.classList.contains('form')) return;
    if (typeof window.gtag !== 'function') return;

    var svc = f.querySelector('[name="service"]');

    window.gtag('event', 'generate_lead', {
      cta_section: ctaSection(f),
      form_service: svc ? svc.value : '',
      page_path: window.location.pathname,
      transport_type: 'beacon'
    });
  }, true);

  /* Was this page load a fresh navigation, rather than a reload or a
     back/forward restore? Keeps a refreshed /thanks/ from booking a second
     conversion. Unknown counts as fresh: over-counting beats dropping a real
     lead, and Ads' "count: one" setting collapses the rare duplicate anyway. */
  function isFreshNavigation() {
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      return !nav || nav.type === 'navigate';
    } catch (err) {
      return true;
    }
  }

  /* Ads lead conversion. Fires on the /thanks/ landing, NOT on submit, for two
     reasons:

       1. Reliability. Unlike GA4 above, the Google Ads conversion ping does not
          reliably honour transport_type 'beacon' — and the submitting document
          is being torn down in the same tick by the native POST. Fired on
          submit, Ads silently under-reports.

       2. Accuracy. Only an accepted lead ever reaches /thanks/. Every Worker
          rejection (400, 403, Turnstile) stops short of it, so a rejected
          submission cannot book a conversion the way it could on submit.

     The ?lead=1 marker is set by the Worker on the success redirect only. The
     honeypot answers with a BARE /thanks/ — identical-looking to a bot, but no
     marker, so a bot that renders the page and trips the honeypot books nothing.
     That path skips Turnstile entirely (the honeypot check runs first), which is
     why the marker rather than Turnstile is what guards this. See
     _worker/src/index.js.

     Expect GA4 generate_lead to exceed Ads conversions. That gap is the Worker's
     rejection rate, not a tagging bug — do not "fix" it by moving this back to
     the submit handler. */
  if (AW_LABEL_LEAD &&
      typeof window.gtag === 'function' &&
      window.location.pathname.replace(/\/+$/, '') === '/thanks' &&
      /(^|&)lead=1(&|$)/.test(window.location.search.slice(1)) &&
      isFreshNavigation()) {
    window.gtag('event', 'conversion', {
      send_to: AW_ID + '/' + AW_LABEL_LEAD
    });
  }
})();
