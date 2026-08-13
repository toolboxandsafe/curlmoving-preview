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

  /* Quote form submissions. The form does a native POST to the Cloudflare
     Worker at /api/quote, which answers 303 to /thanks/, so the page is torn
     down moments after submit — same constraint as the tel:/sms: links above,
     and the same fix: transport_type 'beacon' hands the hit to the browser to
     deliver independently of this document. Never block submit on a callback.

     This fires on submit, not on the /thanks/ landing, so it counts attempts
     rather than accepted leads: a submission the Worker rejects (400 missing
     phone, 403 outside US/HN, Turnstile failure) still counts here. Direct-POST
     spam never loads a page, so it cannot inflate this. */
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

    if (AW_LABEL_LEAD) {
      window.gtag('event', 'conversion', {
        send_to: AW_ID + '/' + AW_LABEL_LEAD,
        transport_type: 'beacon'
      });
    }
  }, true);
})();
