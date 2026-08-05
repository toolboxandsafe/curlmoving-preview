# Quote-form Worker

Receives `POST /api/quote` from the five quote forms on curlmoving.com, emails
the lead to Ryan, and hands it to the `curl-lead-intake` Apps Script.

Replaced Web3Forms. Because curlmoving.com already runs on Cloudflare
nameservers, Cloudflare already sees every request to this site — so this adds
no third party that wasn't already in the path.

## Why the directory starts with an underscore

The site is served by GitHub Pages, which runs default Jekyll (no `.nojekyll`,
no `_config.yml` in the repo root). Jekyll drops `_`-prefixed directories from
the published output, so this source stays in git but is never fetchable at
`curlmoving.com/_worker/...`. Don't rename it without adding a `_config.yml`
`exclude:` entry first.

## One-time setup

1. **Email Routing** — Cloudflare dashboard → curlmoving.com → Email → Email
   Routing. Enable it, then add `ryan@curlvending.com` under **Destination
   addresses** and click the verification link Cloudflare emails. The
   `send_email` binding refuses to send to an unverified address.

   This replaces the `_dc-mx.9854c0b71ccb.curlmoving.com` MX record, which is a
   Google Workspace domain-verification placeholder. Confirm in Workspace Admin
   → Account → Domains that curlmoving.com isn't a live alias domain first.

2. **Turnstile** — Cloudflare dashboard → Turnstile → Add site for
   `curlmoving.com`. Copy the **site key** into the five form pages (it's public)
   and keep the **secret key** for step 3.

3. **Secrets:**

   ```sh
   wrangler secret put TURNSTILE_SECRET    # Turnstile secret key
   wrangler secret put APPS_SCRIPT_URL     # /exec URL of the Apps Script Web App
   wrangler secret put APPS_SCRIPT_TOKEN   # must equal CONFIG.SCRIPT_TOKEN in Code.gs
   ```

4. **Deploy:**

   ```sh
   wrangler deploy
   ```

   No build step and no `package.json` — the MIME encoding is hand-rolled so
   there are no npm dependencies to install.

## Smoke tests

Run these before repointing the site forms at `/api/quote`.

```sh
# happy path — expect 303 to /thanks/, an email, and a Trello card
curl -i -X POST https://curlmoving.com/api/quote \
  --data-urlencode 'name=Test Person' \
  --data-urlencode 'phone=6029354209' \
  --data-urlencode 'email=test@example.com' \
  --data-urlencode 'service=gun-safe' \
  --data-urlencode 'page=gun-safe' \
  --data-urlencode 'message=ignore, smoke test'

# honeypot — expect 303 and absolutely nothing sent anywhere
curl -i -X POST https://curlmoving.com/api/quote \
  --data-urlencode 'name=Bot' --data-urlencode 'phone=6025551234' \
  --data-urlencode 'botcheck=1'

# missing phone — expect 400
curl -i -X POST https://curlmoving.com/api/quote --data-urlencode 'name=Test'

# wrong method — expect 405
curl -i https://curlmoving.com/api/quote
```

The happy-path call carries no Turnstile token, so its subject arrives prefixed
`[UNVERIFIED]`. That is correct: verification soft-fails by default so a real
customer with JS blocked still gets through. Flip `REJECT_ON_TURNSTILE_FAIL` in
`src/index.js` to change that.

## Watching it run

```sh
wrangler tail
```

Failures log a reason and the page slug only. **Request bodies are never
logged**, so no customer data reaches Cloudflare's log stream — keep it that way
when adding logging.

## How this fits with curl-lead-intake

Every submission gets a `lead_id` (UUID) minted here and written into **both**
the email body and the JSON POST. That single identity is what lets the two
delivery paths coexist:

- The **POST** reaches the Apps Script in seconds and drives Trello, RingCentral
  and the customer texts.
- The **email** is Ryan's record, and the fallback — `curl-lead-intake` polls
  Gmail every 5 minutes, and if the POST never landed it processes the emailed
  copy instead. When the POST *did* land, the matching `lead_id` hits the audit
  sheet's idempotency check and the Gmail path no-ops.

So the email body format is load-bearing. `parseEmailBody_()` in `Code.gs`
finds each label with `indexOf` and takes the value as everything up to the
next label, which means:

- label on its own line, value on the next — `Name: Mike` would parse the value
  as `: Mike`, since nothing strips a leading colon;
- no preamble above the first label, because the parser takes the *first*
  occurrence of each label string;
- the footer must start with `Sent from`, which the parser already strips.

Change `buildEmailBody()` and you must change the `FORMS` registry in `Code.gs`
to match.
