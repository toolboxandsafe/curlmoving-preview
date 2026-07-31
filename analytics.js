/* Curl Moving — click-to-call / click-to-text conversion tracking
 *
 * Every conversion on this site is a tel: or sms: link click; there is no
 * working contact form. Without this file, Google Ads reports zero conversions
 * while the phone is ringing.
 *
 * Fires on every tel:/sms: link, on every page, via one delegated listener —
 * so links added later are covered automatically with no code change.
 *
 * ── TO FINISH SETUP ──────────────────────────────────────────────────────────
 * As of the Phase 0 audit, the Ads account had NO website conversion action —
 * no send_to or conversion label appeared anywhere in the old site's source.
 * One has to be created before a label exists. Two options:
 *
 *   A. Import the GA4 event (no change to this file needed).
 *      GA4 > Admin > Events > mark 'click_to_call' as a key event, confirm the
 *      Google Ads link, then Ads > Goals > Conversions > + New conversion
 *      action > Import > Google Analytics 4. The event must have fired at
 *      least once and key events take ~24h to appear.
 *
 *   B. Create a native Ads conversion and set the label below.
 *      Ads > Goals > Conversions > + New conversion action > Phone calls >
 *      "Clicks on your number on your mobile website". Only after it exists
 *      does Tag setup show send_to: 'AW-878922638/XXXXXXXX'. The part after
 *      the slash is AW_CONVERSION_LABEL.
 *
 * With the label blank, GA4 events still fire; only the native Ads conversion
 * is skipped. That is the correct behaviour for option A.
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function () {
  'use strict';

  var AW_ID = 'AW-878922638';
  var AW_CONVERSION_LABEL = ''; // <-- paste the label here, e.g. 'AbC-D_efGh1iJkLmNoP'

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
      link_url: href,
      transport_type: 'beacon'
    });

    if (AW_CONVERSION_LABEL) {
      window.gtag('event', 'conversion', {
        send_to: AW_ID + '/' + AW_CONVERSION_LABEL,
        transport_type: 'beacon'
      });
    }
  }, true); // capture phase: run before the browser hands off to the dialer
})();
