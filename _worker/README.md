# Quote-form Worker

Receives `POST /api/quote` from the quote forms on **curlmoving.com and
curlvending.com**, emails the lead to Ryan, and hands it to the
`curl-lead-intake` Apps Script.

> **This Worker serves two businesses since 2026-09-20.** curlvending.com was
> migrated off WordPress and its forms post here too. One Worker, one Apps
> Script, two sites. Read **Two sites, one Worker** below before changing
> anything — several things here are now shared, and a change made for one
> business can silently break the other's leads.

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

Note there is no curl happy path any more. `REJECT_ON_TURNSTILE_FAIL` went
`true` on 2026-08-05, and curl cannot produce a Turnstile token, so every
well-formed curl below is *supposed* to be rejected. Exercise the accepted-lead
path through the real form in a browser.

```sh
# well-formed but unverified — expect 400, and NO email or Trello card.
# This is the happy path proving Turnstile enforcement, not a failure.
curl -i -X POST https://curlmoving.com/api/quote \
  --data-urlencode 'name=Test Person' \
  --data-urlencode 'phone=6029354209' \
  --data-urlencode 'email=test@example.com' \
  --data-urlencode 'service=gun-safe' \
  --data-urlencode 'page=gun-safe' \
  --data-urlencode 'message=ignore, smoke test'

# honeypot — expect 303 to a BARE /thanks/ (no ?lead=1) and nothing sent
# anywhere. The missing marker is what stops analytics.js booking an Ads
# conversion; an accepted lead redirects to /thanks/?lead=1 instead.
curl -i -X POST https://curlmoving.com/api/quote \
  --data-urlencode 'name=Bot' --data-urlencode 'phone=6025551234' \
  --data-urlencode 'botcheck=1'

# missing phone — expect 400, rejected before Turnstile is even consulted
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

## Two sites, one Worker

`SITES` in `src/index.js` keys off the request hostname. Everything that differs
between the businesses hangs off that: item lists, the thank-you URL, the sender
name, and the `(Curl Vending)` subject marker that `curl-lead-intake` uses to
tell them apart — both sites send from `quotes@curlmoving.com`, so the marker is
the only signal.

**What this means in practice:**

- **`wrangler deploy` deploys both routes.** `wrangler.toml` carries
  `curlmoving.com/api/quote` and `curlvending.com/api/quote`. A deploy for a Curl
  Moving reason also ships whatever is in the tree for Curl Vending.
- **Two Turnstile widgets, two secrets.** `TURNSTILE_SECRET` is
  **curlmoving's** (site key `0x4AAAAAAEHZC8OwWLPiJlV3`);
  `TURNSTILE_SECRET_VENDING` is curlvending's (`0x4AAAAAAE3wlgvfplSXBN23`).
  `SITES[host].turnstileSecret` picks which. **Never overwrite `TURNSTILE_SECRET`
  with a Curl Vending key** — Turnstile hard-fails, so every Curl Moving lead
  would vanish with no error anywhere. A cutover doc said to do exactly that; it
  was caught before deploying, on 2026-09-21.
- **There is no fallback between the two secrets**, deliberately. The wrong
  widget's secret never verifies, so falling back would lose the lead anyway
  while hiding the cause. A missing one logs the variable name it wanted.
- **Turnstile failures log their reason** since 2026-09-21:
  `turnstile failed <domain>: invalid-input-secret` distinguishes a bad secret
  from a bad token. `wrangler tail` while submitting is the fastest diagnosis.
- **`curl-lead-intake` is shared.** One Apps Script project handles both. Its
  `FORMS` table carries `curlmoving_*` and `curlvending_*` entries, and editing it
  for one business touches the other's leads. It is deliberately **not** a git
  repo, so **copy the live `Code.gs` out and diff it before overwriting** —
  2026-09-21 that caught a local copy whose `RC_CLIENT_ID` had a stray leading
  character, which would have killed SMS for both businesses.
- **Only the moving forms text the customer** (Ryan, 2026-09-21). Curl Vending's
  two sales forms carry `sms: false` in `Code.gs`. All Curl Moving forms text as
  before — unchanged, and pinned by tests.

**Tests cover both sites and assert Curl Moving is unaffected.** They live in the
Vending-Curl project and read this source directly:

```sh
node "C:/Users/luigg/CLAUDE CODE PROJECTS/Vending-Curl/worker/test_worker.mjs"       # 28 checks
node "C:/Users/luigg/CLAUDE CODE PROJECTS/Vending-Curl/worker/test_lead_intake.mjs"  # 31 checks
```

Run both before any deploy from here, whichever business the change is for.

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
