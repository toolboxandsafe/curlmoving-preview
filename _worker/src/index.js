/**
 * Curl Moving — quote form intake.
 *
 * Replaces a third-party form relay (Web3Forms). Because curlmoving.com already
 * runs on Cloudflare nameservers, Cloudflare already terminates TLS for every
 * request to this site — routing the form through a Worker therefore adds no
 * party that was not already in the path. The lead reaches Ryan two ways:
 *
 *   1. Email, via the Email Routing binding → his Google Workspace inbox.
 *      This is his human-readable record AND the fallback: curl-lead-intake
 *      polls Gmail every 5 minutes and will pick the lead up from the email if
 *      step 2 never landed.
 *
 *   2. A direct POST to the curl-lead-intake Apps Script, which creates the
 *      Trello card, saves the RingCentral contact, and texts the customer
 *      within seconds instead of within five minutes.
 *
 * Both carry the same `lead_id`, minted here. That is what lets the two paths
 * coexist without double-processing: whichever arrives second hits the audit
 * sheet's idempotency check and no-ops. See ../../.. plan notes and Code.gs.
 *
 * PRIVACY: request bodies are never logged. Failures log a reason and the page
 * slug only, so no customer data enters Cloudflare's log stream.
 */

import { EmailMessage } from 'cloudflare:email';

/* Reject submissions that fail Turnstile.
   Started false — a real customer with JS blocked seemed worth more than the
   spam a filterable [UNVERIFIED] prefix admits. Flipped 2026-08-05 after Russian
   link-spam POSTed straight to this endpoint within hours of launch, skipping
   the form (and therefore the honeypot) entirely. The deciding factor was not
   the junk Trello card but the next case: spam carrying a plausible 10-digit US
   number would pass normalizePhone_ and make the intake script send three texts
   to a stranger from the business line. */
const REJECT_ON_TURNSTILE_FAIL = true;

/* Only these countries may submit. The business serves the Phoenix metro, and
   Ryan works from Honduras — nobody else has a legitimate reason to post here.
   ISO 3166-1 alpha-2, from Cloudflare's request.cf.country. */
const ALLOWED_COUNTRIES = ['US', 'HN'];

/* Rate limiting lives in a WAF rule on the zone, not here — see the note in
   wrangler.toml for why the experimental Workers binding was abandoned. The
   guarded RATE_LIMITER block below is inert without a binding and left in place
   only so a future stable binding can be dropped in. */

/* Form `service` value → human label used in the subject and email body.
   Keys must stay in sync with the <select name="service"> options on the site
   and with the subjectMatch regexes in curl-lead-intake/Code.gs. */
const ITEMS = {
  'gun-safe': 'Gun Safe',
  'tool-box': 'Tool Box',
  'vending-machine': 'Vending Machine',
  'scissor-lift': 'Scissor Lift',
  'other': 'Other Heavy Item',
};

/* Two sites post here. The mail binding, the geo gate, the honeypot, Turnstile and
   the Apps Script hand-off are shared; only the wording and the destinations differ.
   Keyed by request hostname; an unknown host falls back to Curl Moving, which is how
   this Worker behaved before curlvending.com was added, so nothing changes for it.

   MAIL_FROM stays quotes@curlmoving.com for BOTH sites. Email Routing is enabled on
   the curlmoving.com zone, and the binding belongs to the Worker rather than to the
   zone the request arrived on — which is what lets curlvending.com use it without
   ever enabling Email Routing on its own zone, where that would replace the Google
   Workspace MX and kill ryan@curlvending.com. */
const SITES = {
  'curlmoving.com': {
    label: 'Curl Moving',
    domain: 'curlmoving.com',
    subjectTag: '',
    /* Each site has its OWN Turnstile widget, so each needs its own secret. Sharing one
       would make every submission on the other site fail verification, and Turnstile is
       hard-fail, so those leads would vanish with no error anywhere.
       curlmoving site key 0x4AAAAAAEHZC8OwWLPiJlV3, curlvending 0x4AAAAAAE3wlgvfplSXBN23. */
    turnstileSecret: 'TURNSTILE_SECRET',
    items: ITEMS,
    salesServices: [],
  },
  'curlvending.com': {
    label: 'Curl Vending',
    domain: 'curlvending.com',
    /* Both sites send from the same address, so the Gmail fallback in curl-lead-intake
       cannot tell them apart by sender. This marker in the subject is how it does.
       Keep it in step with the curlvending_* subjectMatch regexes in Code.gs. */
    subjectTag: ' (Curl Vending)',
    turnstileSecret: 'TURNSTILE_SECRET_VENDING',
    thanksUrl: 'https://curlvending.com/submitted-quote-form/',
    fromName: 'Curl Vending',
    items: {
      'vending-placement': 'Vending Machine Placement',
      'micro-market': 'Micro Market',
      'vending-machine': 'Vending Machine',
      'tool-box': 'Tool Box',
      'gun-safe': 'Gun Safe',
      'scissor-lift': 'Scissor Lift',
      'other': 'Other Heavy Item',
    },
    /* These two ask for a machine to be installed rather than for something to be
       moved, so they carry no pickup/delivery and get their own wording downstream. */
    salesServices: ['vending-placement', 'micro-market'],
  },
};

function siteFor(hostname) {
  return SITES[String(hostname || '').replace(/^www\./, '')] || SITES['curlmoving.com'];
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const site = siteFor(url.hostname);

    if (url.pathname !== '/api/quote') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    /* Rate limit first — cheapest check, and it runs before we parse a body or
       call out to Turnstile. Keyed on IP. If the binding is missing (local dev)
       this is skipped rather than failing closed. */
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (env.RATE_LIMITER) {
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) {
          console.error('rate limited');
          return new Response('Too many requests', {
            status: 429, headers: { 'Retry-After': '60' },
          });
        }
      } catch (err) {
        // Never let a rate-limiter fault block a real lead.
        console.error('rate limiter error: ' + String(err && err.message || err).slice(0, 120));
      }
    }

    /* Geo gate. request.cf is absent under `wrangler dev` and in unit tests, so
       treat a missing country as allowed rather than locking out development. */
    const country = request.cf && request.cf.country;
    if (country && ALLOWED_COUNTRIES.indexOf(country) === -1) {
      console.error(`blocked country=${country}`);
      return htmlResponse(outsideAreaPage(env, site), 403);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const f = (k) => String(form.get(k) || '').trim();

    /* Honeypot. Bots fill hidden fields; people never see this one. Answer with
       a redirect to the thanks page so the bot learns nothing.

       Note this runs BEFORE the Turnstile check below, so a bot that renders the
       page and trips this reaches /thanks/ without ever being verified. That is
       why the URL here is bare: the success path appends ?lead=1 (see
       thanksUrl), and analytics.js books the Ads lead conversion only when that
       marker is present. Both responses are a 303 to an identically-rendered
       page, so the honeypot still gives nothing away. Do not add the marker
       here. */
    if (f('botcheck')) return seeOther(site.thanksUrl || env.THANKS_URL);

    const name = f('name');
    const phone = f('phone');
    if (!name || !phone) {
      return htmlResponse(problemPage(env, site, 'Please include your name and a phone number so I can reach you.'), 400);
    }

    const serviceKey = f('service') || 'other';
    const lead = {
      lead_id: crypto.randomUUID(),
      item_key: serviceKey,
      item: site.items[serviceKey] || site.items.other,
      name,
      phone,
      email: f('email'),
      pickup_address: f('pickup'),
      delivery_address: f('dropoff'),
      requested_date: f('when'),
      message: f('message'),
      page: f('page') || serviceKey,
      /* Which site this came from. Both post through this Worker with the same service
         values, so without it curl-lead-intake files a Curl Vending lead as a Curl
         Moving one — right item, wrong business, wrong text to the customer. */
      site: site.domain,
      /* Curl Vending's forms carry a few fields Curl Moving's do not. Anything the
         builder could not map keeps an x_ prefix and is passed through under "Other
         Details", so a form change can never silently drop an answer. */
      business: f('business'),
      pickup_business: f('pickup_business'),
      delivery_business: f('dropoff_business'),
      count: f('count'),
      contact_method: f('contact_method'),
      extras: [...form.entries()]
        .filter(([k, v]) => k.startsWith('x_') && String(v).trim())
        .map(([k, v]) => `${k.slice(2).replace(/_/g, ' ')}: ${String(v).trim()}`)
        .join('; '),
      sales: site.salesServices.indexOf(serviceKey) !== -1,
    };

    /* Turnstile. Hard-fail since 2026-08-05 — see REJECT_ON_TURNSTILE_FAIL.
       No token means no lead, so a wrong site key in the page markup costs
       every lead from that page. */
    const verified = await verifyTurnstile(env, site, form.get('cf-turnstile-response'), request);
    if (!verified && REJECT_ON_TURNSTILE_FAIL) {
      console.error(`turnstile rejected page=${lead.page}`);
      return htmlResponse(problemPage(env, site,
        'That submission could not be verified. If you have JavaScript disabled, please text or call instead — it is faster anyway.'), 400);
    }
    lead.verified = verified;

    /* Email first, and awaited: it is both the record and the fallback, so it
       is the one delivery that must not be fire-and-forget. */
    try {
      await sendLeadEmail(env, lead, site);
    } catch (err) {
      console.error(`send_email failed page=${lead.page} reason=${String(err && err.message || err).slice(0, 200)}`);
      // Nothing has reached Ryan. Give the customer their text back rather than
      // a blank 500, so the effort isn't lost.
      return htmlResponse(lostPage(env, site, lead), 200);
    }

    /* Apps Script drives the automation. Deliberately not awaited before the
       redirect: Apps Script cold starts can take seconds, and if it fails the
       Gmail fallback path recovers the lead within five minutes anyway. */
    if (env.APPS_SCRIPT_URL && env.APPS_SCRIPT_TOKEN) {
      ctx.waitUntil(postToAppsScript(env, lead));
    }

    return seeOther(thanksUrl(env, site));
  },
};

/* ─────────────────────────────────────────────────────────────────────────
   Turnstile
   ───────────────────────────────────────────────────────────────────────── */

async function verifyTurnstile(env, site, token, request) {
  /* Deliberately no fallback to TURNSTILE_SECRET: verifying against the wrong widget's
     secret always fails, and a hard-fail costs the lead. An unset secret fails the same
     way, but `turnstile secret missing` in the log says which. */
  const secret = env[(site && site.turnstileSecret) || 'TURNSTILE_SECRET'];
  if (!secret) {
    console.error(`turnstile secret missing: ${(site && site.turnstileSecret) || 'TURNSTILE_SECRET'}`);
    return false;
  }
  if (!token) return false;
  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', String(token));
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.append('remoteip', ip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
    /* Log why, not just that. Cloudflare returns `invalid-input-secret` for a wrong or
       missing secret and `invalid-input-response` for a bad token — very different
       problems that otherwise look identical, because both end as a lost lead. */
    if (data.success !== true) {
      console.error(`turnstile failed ${(site && site.domain) || '?'}: ${(data['error-codes'] || []).join(',') || 'no error code'}`);
    }
    return data.success === true;
  } catch (err) {
    console.error('turnstile verify error: ' + String(err && err.message || err).slice(0, 200));
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Apps Script hand-off
   ───────────────────────────────────────────────────────────────────────── */

async function postToAppsScript(env, lead) {
  try {
    const res = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Apps Script's doPost(e) exposes postData but not custom request
      // headers, so the shared secret has to travel inside the payload.
      body: JSON.stringify({ token: env.APPS_SCRIPT_TOKEN, lead }),
    });
    if (!res.ok) {
      console.error(`apps script HTTP ${res.status} page=${lead.page}`);
    }
  } catch (err) {
    // Not fatal: the emailed copy is still in the inbox and the 5-minute Gmail
    // trigger will process it. Logged so the audit trail shows which path ran.
    console.error(`apps script post failed page=${lead.page} reason=${String(err && err.message || err).slice(0, 200)}`);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Email
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Body format is load-bearing — curl-lead-intake's parseEmailBody_() locates
 * each label with indexOf and takes the value as everything up to the next
 * label. That means:
 *   - label on its own line, value on the next. "Name: Mike" would parse as
 *     the value ": Mike", because nothing strips a leading colon.
 *   - no preamble above the first label, since the parser takes the FIRST
 *     occurrence of each label string.
 *   - the footer starts with "Sent from", which the parser already strips.
 */
function buildEmailBody(lead, site) {
  /* Every label emitted here must be declared in the matching FORMS entry in
     curl-lead-intake, as `fields`, `address_business_prefix` or `extras`. The parser
     takes each value as the text up to the NEXT label it knows, so an undeclared label
     is not ignored — it is swallowed into the previous field's value. */
  let rows;
  if (site.domain !== 'curlvending.com') {
    rows = [
      ['Lead ID', lead.lead_id],
      ['Item', lead.item],
      ['Name', lead.name],
      ['Phone', lead.phone],
      ['Email', lead.email],
      ['Pickup Address', lead.pickup_address],
      ['Delivery Address', lead.delivery_address],
      ['Requested Date', lead.requested_date],
      ['Message', lead.message],
    ];
  } else if (lead.sales) {
    // Asking for a machine or a micro market: no pickup, no delivery, no date.
    rows = [
      ['Lead ID', lead.lead_id],
      ['Item', lead.item],
      ['Name', lead.name],
      ['Phone', lead.phone],
      ['Email', lead.email],
      ['Business', lead.business],
      ['Contact Method', lead.contact_method],
      ['Message', lead.message],
      ['Other Details', lead.extras],
    ];
  } else {
    rows = [
      ['Lead ID', lead.lead_id],
      ['Item', lead.item],
      ['Name', lead.name],
      ['Phone', lead.phone],
      ['Email', lead.email],
      ['Pick Up Business', lead.pickup_business],
      ['Pickup Address', lead.pickup_address],
      ['Drop Off Business', lead.delivery_business],
      ['Delivery Address', lead.delivery_address],
      ['Number Of Items', lead.count],
      ['Requested Date', lead.requested_date],
      ['Contact Method', lead.contact_method],
      ['Message', lead.message],
      ['Other Details', lead.extras],
    ];
  }

  const out = [];
  for (const [label, value] of rows) {
    out.push(label);
    out.push(value || '(not given)');
  }
  out.push('');
  out.push(`Sent from ${site.domain} — ${lead.page}${lead.verified ? '' : ' — Turnstile unverified'}`);
  return out.join('\n');
}

async function sendLeadEmail(env, lead, site) {
  const from = env.MAIL_FROM;
  const to = env.MAIL_TO;

  // Bound the name's contribution so a pathological value can't produce an
  // absurd Subject header.
  const shortName = lead.name.length > 40 ? lead.name.slice(0, 40) + '…' : lead.name;
  const subject = `${lead.verified ? '' : '[UNVERIFIED] '}Quote request${site.subjectTag} — ${lead.item} — ${shortName}`;

  const headers = [
    `From: ${encodeHeaderWord(site.fromName || env.MAIL_FROM_NAME)} <${from}>`,
    `To: <${to}>`,
  ];

  // Reply-To only when the address is plausible, so a junk value can't make the
  // whole message unparseable to the receiving MTA.
  if (lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    headers.push(`Reply-To: <${lead.email}>`);
  }

  headers.push(
    `Message-ID: <${lead.lead_id}@${site.domain}>`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  );

  const raw = headers.join('\r\n') + '\r\n\r\n' + wrap76(b64(utf8(buildEmailBody(lead, site)))) + '\r\n';

  await env.SEND_EMAIL.send(new EmailMessage(from, to, raw));
}

/* ─────────────────────────────────────────────────────────────────────────
   MIME helpers — hand-rolled so the Worker has no npm dependencies and
   deploying is a bare `wrangler deploy` with no build step.
   ───────────────────────────────────────────────────────────────────────── */

function utf8(str) {
  return new TextEncoder().encode(str);
}

function b64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function wrap76(s) {
  const lines = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join('\r\n');
}

/**
 * RFC 2047 encoded-word for header values containing non-ASCII (the subject
 * uses em dashes). Plain ASCII is passed through untouched.
 *
 * An encoded-word may not exceed 75 characters. `=?UTF-8?B?` + `?=` costs 12,
 * leaving 63 for base64, which encodes 47 source bytes — so chunks are capped
 * at 45 to stay clear of the limit, and split only on UTF-8 character
 * boundaries so a multi-byte sequence is never cut in half.
 */
function encodeHeaderWord(str) {
  if (!/[^\x20-\x7E]/.test(str)) return str;

  const bytes = utf8(str);
  const words = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + 45, bytes.length);
    // Walk back off a continuation byte (10xxxxxx) so chunks split cleanly.
    while (end > i && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    words.push('=?UTF-8?B?' + b64(bytes.slice(i, end)) + '?=');
    i = end;
  }
  // Folding whitespace between encoded-words; decoders drop it on reassembly.
  return words.join('\r\n ');
}

/* ─────────────────────────────────────────────────────────────────────────
   Responses
   ───────────────────────────────────────────────────────────────────────── */

function seeOther(location) {
  // 303 so the browser re-issues as GET — a native form POST would otherwise
  // re-submit on refresh.
  return new Response(null, { status: 303, headers: { Location: location } });
}

/**
 * Thanks URL for an ACCEPTED lead only. The ?lead=1 marker is what tells
 * analytics.js it may book the Google Ads lead conversion — every other path to
 * /thanks/ (the honeypot above, a bookmark, a direct visit) arrives without it
 * and books nothing.
 *
 * Appended here rather than baked into THANKS_URL in wrangler.toml on purpose:
 * the honeypot has to keep answering with the bare URL for the two responses to
 * stay indistinguishable to a bot.
 */
function thanksUrl(env, site) {
  const base = (site && site.thanksUrl) || env.THANKS_URL;
  return base + (base.indexOf('?') === -1 ? '?' : '&') + 'lead=1';
}

function htmlResponse(html, status) {
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function shell(title, inner, site) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc((site && site.label) || 'Curl Moving')}</title>
<style>
  body{margin:0;padding:48px 24px;background:#f2ece2;color:#1c1a17;
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .box{max-width:560px;margin:0 auto;background:#fbf7f0;border:2px solid #1c1a17;
       box-shadow:6px 6px 0 #1c1a17;padding:32px}
  h1{margin:0 0 16px;font-size:26px;line-height:1.2;text-transform:uppercase;letter-spacing:.01em}
  a.btn{display:inline-block;margin-top:8px;margin-right:8px;padding:14px 22px;background:#c0451a;color:#fff;
        text-decoration:none;font-weight:700;border:2px solid #1c1a17;box-shadow:4px 4px 0 #1c1a17}
  a.plain{color:#c0451a}
  pre{white-space:pre-wrap;word-break:break-word;background:#f2ece2;border:1px solid #cfc4b4;padding:12px;font-size:13px}
</style></head><body><div class="box">${inner}</div></body></html>`;
}

/* Shown when the submission comes from outside the served countries. Kept
   polite and with the phone number visible, because the rare false positive is
   a real person on a VPN or travelling. */
function outsideAreaPage(env, site) {
  return shell('Outside our service area', `
    <h1>We only serve Arizona</h1>
    <p>This form is limited to the Phoenix metro area. If you are genuinely
       trying to reach us here and landed on this page by mistake — a VPN will
       do it — call or text and I will sort it out directly.</p>
    <a class="btn" href="sms:${esc(env.CONTACT_PHONE_E164)}">Text ${esc(env.CONTACT_PHONE)}</a>
    <a class="btn" href="tel:${esc(env.CONTACT_PHONE_E164)}">Call</a>`, site);
}

function problemPage(env, site, msg) {
  return shell('Check the form', `
    <h1>One thing missing</h1>
    <p>${esc(msg)}</p>
    <p>Or skip the form entirely — texting is faster anyway.</p>
    <a class="btn" href="sms:${esc(env.CONTACT_PHONE_E164)}">Text ${esc(env.CONTACT_PHONE)}</a>
    <a class="btn" href="tel:${esc(env.CONTACT_PHONE_E164)}">Call</a>
    <p><a class="plain" href="javascript:history.back()">← Back to the form</a></p>`, site);
}

/**
 * Shown only when the email send itself failed, i.e. nothing reached Ryan.
 * Hands the customer their own text back with a prefilled mailto so the effort
 * isn't lost — the exact failure mode (silent loss) this rewrite exists to fix.
 */
function lostPage(env, site, lead) {
  const summary = [
    `Item: ${lead.item}`,
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    lead.email ? `Email: ${lead.email}` : '',
    lead.business ? `Business: ${lead.business}` : '',
    lead.pickup_address ? `Pickup: ${lead.pickup_address}` : '',
    lead.delivery_address ? `Delivery: ${lead.delivery_address}` : '',
    lead.requested_date ? `When: ${lead.requested_date}` : '',
    lead.message ? `Details: ${lead.message}` : '',
  ].filter(Boolean).join('\n');

  const mailto = `mailto:${env.MAIL_TO}?subject=${encodeURIComponent('Quote request — ' + lead.item)}&body=${encodeURIComponent(summary)}`;

  return shell('Send didn\'t go through', `
    <h1>That didn't send</h1>
    <p>Something on my end failed — this one is on me, not you. Fastest fix is to
       text me directly; I answer every one personally.</p>
    <a class="btn" href="sms:${esc(env.CONTACT_PHONE_E164)}">Text ${esc(env.CONTACT_PHONE)}</a>
    <a class="btn" href="tel:${esc(env.CONTACT_PHONE_E164)}">Call</a>
    <p style="margin-top:24px">Or <a class="plain" href="${esc(mailto)}">email it instead</a> —
       here is what you typed, so nothing is lost:</p>
    <pre>${esc(summary)}</pre>`, site);
}
