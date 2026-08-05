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

/* Flip to true to reject submissions that fail Turnstile instead of letting
   them through tagged [UNVERIFIED]. Left false deliberately: a real customer
   with JS blocked is worth more than the spam a filterable prefix admits. */
const REJECT_ON_TURNSTILE_FAIL = false;

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/api/quote') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return new Response('Bad request', { status: 400 });
    }

    const f = (k) => String(form.get(k) || '').trim();

    /* Honeypot. Bots fill hidden fields; people never see this one. Answer with
       the same redirect a real submission gets so the bot learns nothing. */
    if (f('botcheck')) return seeOther(env.THANKS_URL);

    const name = f('name');
    const phone = f('phone');
    if (!name || !phone) {
      return htmlResponse(problemPage(env, 'Please include your name and a phone number so I can reach you.'), 400);
    }

    const serviceKey = f('service') || 'other';
    const lead = {
      lead_id: crypto.randomUUID(),
      item_key: serviceKey,
      item: ITEMS[serviceKey] || ITEMS.other,
      name,
      phone,
      email: f('email'),
      pickup_address: f('pickup'),
      delivery_address: f('dropoff'),
      requested_date: f('when'),
      message: f('message'),
      page: f('page') || serviceKey,
    };

    /* Turnstile. Soft-fail by default — see REJECT_ON_TURNSTILE_FAIL. */
    const verified = await verifyTurnstile(env, form.get('cf-turnstile-response'), request);
    if (!verified && REJECT_ON_TURNSTILE_FAIL) {
      return htmlResponse(problemPage(env, 'That submission could not be verified. Please try again.'), 400);
    }
    lead.verified = verified;

    /* Email first, and awaited: it is both the record and the fallback, so it
       is the one delivery that must not be fire-and-forget. */
    try {
      await sendLeadEmail(env, lead);
    } catch (err) {
      console.error(`send_email failed page=${lead.page} reason=${String(err && err.message || err).slice(0, 200)}`);
      // Nothing has reached Ryan. Give the customer their text back rather than
      // a blank 500, so the effort isn't lost.
      return htmlResponse(lostPage(env, lead), 200);
    }

    /* Apps Script drives the automation. Deliberately not awaited before the
       redirect: Apps Script cold starts can take seconds, and if it fails the
       Gmail fallback path recovers the lead within five minutes anyway. */
    if (env.APPS_SCRIPT_URL && env.APPS_SCRIPT_TOKEN) {
      ctx.waitUntil(postToAppsScript(env, lead));
    }

    return seeOther(env.THANKS_URL);
  },
};

/* ─────────────────────────────────────────────────────────────────────────
   Turnstile
   ───────────────────────────────────────────────────────────────────────── */

async function verifyTurnstile(env, token, request) {
  if (!env.TURNSTILE_SECRET || !token) return false;
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET);
    body.append('response', String(token));
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip) body.append('remoteip', ip);

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = await res.json();
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
function buildEmailBody(lead) {
  const rows = [
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
  const out = [];
  for (const [label, value] of rows) {
    out.push(label);
    out.push(value || '(not given)');
  }
  out.push('');
  out.push(`Sent from curlmoving.com — ${lead.page}${lead.verified ? '' : ' — Turnstile unverified'}`);
  return out.join('\n');
}

async function sendLeadEmail(env, lead) {
  const from = env.MAIL_FROM;
  const to = env.MAIL_TO;

  // Bound the name's contribution so a pathological value can't produce an
  // absurd Subject header.
  const shortName = lead.name.length > 40 ? lead.name.slice(0, 40) + '…' : lead.name;
  const subject = `${lead.verified ? '' : '[UNVERIFIED] '}Quote request — ${lead.item} — ${shortName}`;

  const headers = [
    `From: ${encodeHeaderWord(env.MAIL_FROM_NAME)} <${from}>`,
    `To: <${to}>`,
  ];

  // Reply-To only when the address is plausible, so a junk value can't make the
  // whole message unparseable to the receiving MTA.
  if (lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    headers.push(`Reply-To: <${lead.email}>`);
  }

  headers.push(
    `Message-ID: <${lead.lead_id}@curlmoving.com>`,
    `Date: ${new Date().toUTCString()}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  );

  const raw = headers.join('\r\n') + '\r\n\r\n' + wrap76(b64(utf8(buildEmailBody(lead)))) + '\r\n';

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

function shell(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Curl Moving</title>
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

function problemPage(env, msg) {
  return shell('Check the form', `
    <h1>One thing missing</h1>
    <p>${esc(msg)}</p>
    <p>Or skip the form entirely — texting is faster anyway.</p>
    <a class="btn" href="sms:${esc(env.CONTACT_PHONE_E164)}">Text ${esc(env.CONTACT_PHONE)}</a>
    <a class="btn" href="tel:${esc(env.CONTACT_PHONE_E164)}">Call</a>
    <p><a class="plain" href="javascript:history.back()">← Back to the form</a></p>`);
}

/**
 * Shown only when the email send itself failed, i.e. nothing reached Ryan.
 * Hands the customer their own text back with a prefilled mailto so the effort
 * isn't lost — the exact failure mode (silent loss) this rewrite exists to fix.
 */
function lostPage(env, lead) {
  const summary = [
    `Item: ${lead.item}`,
    `Name: ${lead.name}`,
    `Phone: ${lead.phone}`,
    lead.email ? `Email: ${lead.email}` : '',
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
    <pre>${esc(summary)}</pre>`);
}
