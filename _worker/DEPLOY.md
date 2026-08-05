# Deploy checklist — quote form

Everything in this list needs an account only Ryan has. The code on both sides
is written and tested; nothing here touches the live site until step 8.

Lives in `_worker/` so GitHub Pages never publishes it (Jekyll drops
`_`-prefixed directories).

---

## 0. Install wrangler

Not present on this machine as of 2026-08-05:

```sh
npm install -g wrangler
wrangler login
```

`wrangler login` opens a browser for Cloudflare OAuth, so it can't be scripted.
Confirm with `wrangler whoami` before moving on.

## 1. Pre-flight — do this before touching DNS

**Is `curlmoving.com` an alias domain in Google Workspace?**

Admin console → Account → Domains → Manage domains.

Its only MX record today is `_dc-mx.9854c0b71ccb.curlmoving.com`, which is a
Google *domain-verification placeholder*, not a mail route. Enabling Cloudflare
Email Routing replaces it.

- **Not listed, or listed with no users/aliases** → carry on, nothing is lost.
- **Listed and actually in use** → stop. Enable Email Routing on
  `mail.curlmoving.com` instead and tell me, so I change one line in
  `wrangler.toml`.

Every email address on the site is `@curlvending.com`, so this is very likely
vestigial — but it's a DNS change, so confirm rather than assume.

---

## 2. Cloudflare Email Routing

Dashboard → **curlmoving.com** → Email → Email Routing → **Enable**.

Then **Destination addresses** → Add → `ryan@curlvending.com` → click the
verification link Cloudflare emails you.

The `send_email` binding will refuse to send to an unverified address, so this
must be green before step 6 works.

## 3. Turnstile

Dashboard → Turnstile → **Add site**, domain `curlmoving.com`, widget mode
**Managed**.

You get two keys:

- **Site key** → paste into the five form pages, replacing
  `TURNSTILE_SITE_KEY_HERE`. Send it to me, or find/replace it yourself. It is
  public by design — it belongs in the HTML.
- **Secret key** → step 6.

If this key is wrong the widget just produces no token and the Worker still
accepts the lead, tagged `[UNVERIFIED]`. Unlike the old Web3Forms key, a bad
value here costs you nothing.

## 4. Trello labels — DEFERRED, skip for now

**Do this after step 10, not before.** It is on the list only so it isn't
forgotten.

All six `TRELLO_LABELS` entries are still `PASTE_*_LABEL_ID`, including the new
`scissorlift`. `createTrelloCard_()` detects the placeholder and creates the
card without a label, so the only cost is uncoloured cards — and they have been
uncoloured since the original setup. Fetching label ids means a Trello API
round-trip, which is not worth putting between you and a working form.

When you do come back to it: Board → Labels → create **Scissor Lift** (orange
suggested), then

```
https://api.trello.com/1/boards/{BOARD_ID}/labels?key={KEY}&token={TOKEN}
```

and paste the ids into `CONFIG.TRELLO_LABELS.*` in `Code.gs`.

## 5. Deploy the Apps Script Web App

In the Apps Script editor for **curl-lead-intake**:

1. Pick a shared secret — any long random string. Put it in
   `CONFIG.SCRIPT_TOKEN`, replacing `CHANGE_ME_SHARED_SECRET`.
2. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
3. Copy the `/exec` URL.

"Anyone" only means Google won't demand a login. `SCRIPT_TOKEN` is the real
authentication, and the Worker sends it in every request body. Treat it like a
password.

Before deploying, run these two from the function dropdown — neither touches
Trello, RingCentral, or Gmail:

- `testWithSampleEmail()` — exercises the email fallback parser
- `testDoPostPayload()` — exercises the direct POST mapping

Both print `TEST FAIL` lines if anything is wrong. Silence is success.

## 6. Worker secrets and deploy

```sh
cd _worker
wrangler secret put TURNSTILE_SECRET     # from step 3
wrangler secret put APPS_SCRIPT_URL      # the /exec URL from step 5
wrangler secret put APPS_SCRIPT_TOKEN    # same string as CONFIG.SCRIPT_TOKEN
wrangler deploy
```

## 7. Smoke test — before the site changes

```sh
curl -i -X POST https://curlmoving.com/api/quote \
  --data-urlencode 'name=Test Person' \
  --data-urlencode 'phone=6029354209' \
  --data-urlencode 'service=gun-safe' \
  --data-urlencode 'page=gun-safe' \
  --data-urlencode 'message=smoke test, ignore'
```

Expect all four:

- [ ] `303` with `Location: https://curlmoving.com/thanks/`
- [ ] email in the inbox within a minute, subject `[UNVERIFIED] Quote request — Gun Safe — Test Person`
- [ ] Trello card at the top of New Leads, titled `Test Person — Gun Safe`
- [ ] audit sheet row, `Source = post`

`[UNVERIFIED]` is correct here — curl sends no Turnstile token.

**Check where the email landed.** If it went to spam, add a Gmail filter for
`from:quotes@curlmoving.com` → Never send to spam. This matters more than it
looks: `GmailApp.search` does not scan spam, so a spam-filed lead is invisible
to the fallback path.

## 8. Ship the site

Only after step 7 is fully green:

```sh
git add -A && git commit && git push
```

Then **purge the Cloudflare cache**. HTTPS on this domain comes from Cloudflare
rather than GitHub, so GitHub Pages' "Enforce HTTPS" must stay **off**.

---

## 9. Prove the safety net actually works

This is the test worth not skipping. The design says a failed POST still
reaches you by email — but a fallback that's never been exercised is just a
belief.

1. Temporarily point the Worker at a dead endpoint:
   `wrangler secret put APPS_SCRIPT_URL` → `https://example.invalid/exec`
2. Submit the form from a phone.
3. You should still get the email. No Trello card yet.
4. Within 5 minutes the Gmail trigger picks it up: card appears, texts send,
   and the audit row reads `Source = gmail-fallback`.
5. Restore the real URL.

Then confirm the reverse — that both paths together never double-process:

6. Submit normally. Exactly **one** audit row, `Source = post`.
7. Wait 5+ minutes for a trigger cycle. Still exactly one row. The emailed copy
   carries the same `lead_id`, so the Gmail path recognises it and no-ops.

## 10. Full end-to-end

Real submission from a phone on the live site:

- [ ] email arrives with the customer's address in **Reply-To** (hit reply — it
      should address them, not you)
- [ ] Trello card with the right label colour
- [ ] contact saved in RingCentral
- [ ] all three texts arrive, in order
- [ ] audit row `OverallStatus = success`
- [ ] one submission per item type, **especially scissor lift** — that one has
      never worked before

---

## Still outstanding after this

- **`AW_CONVERSION_LABEL` in `analytics.js` is empty.** The form fires a
  `generate_lead` event, but Google Ads won't attribute it until a conversion
  action exists in the Ads account. Worth doing next.
- **Credentials in `Code.gs` are plaintext** — Trello key and token,
  RingCentral client secret, and a JWT valid until 2094, all at lines 50-97.
  Not in a git repo, so nothing is published, but they belong in
  `PropertiesService`. Deliberately left alone here so a credential migration
  isn't tangled up with a change to the lead path.
