# patches/

Runtime overrides bind-mounted over files inside the `postiz` image. The image
runs `:latest`, so anything patched by `docker exec` is silently lost on the next
pull — mounting from here keeps the change durable and visible in git.

**Every file here shadows an upstream file.** If Postiz later fixes the same file,
the mount hides that fix. Diff against the image on upgrade — see below.

## linkedin.page.provider.js

**Status: staged, NOT active.** The two mount lines in `docker-compose.yaml` are
commented out. Uncomment them and `docker compose up -d postiz` once Community
Management API is approved on the LinkedIn app.

### Why

LinkedIn refuses to let any other product coexist with Community Management API
on the same app:

> Your application has another product requested or added to it which requires
> that it be the only product on the application for legal and security reasons.

CMA is the only source of `w_organization_social`, which is the only way to post
to a Company Page. So the app posting for Zablefy (`864258cel0yzlo`) is CMA-only
and can never hold `openid` or `profile` — those come from *Sign In with LinkedIn
using OpenID Connect*, which the rule permanently bars.

Stock Postiz requests all 7 scopes in a single authorization request, and LinkedIn
rejects the entire request if any one scope is unauthorized. So the stock provider
cannot connect a Page on a CMA-only app, before or after approval. The failure
looks identical either way — LinkedIn's "Bummer, something went wrong" page and a
generic *Could not add provider* in the UI — only the offending scope differs.

### What it changes

Four edits against the image's copy (`.orig` alongside is the unmodified file):

1. **Scopes** drop `openid` and `profile`, leaving the 5 CMA grants:
   `w_member_social`, `r_basicprofile`, `rw_organization_admin`,
   `w_organization_social`, `r_organization_social`.
   `w_member_social` stays — `/rest/documents` and `/rest/images` consume it, and
   Postiz uses those when a post has media.
2. **`authenticate()`** replaces `/v2/userinfo` + `/v2/me` with one `/rest/me`.
   Only the member `id` is load-bearing: `no.auth.integrations.controller.js`
   throws `NotEnoughScopes('Invalid API key')` on a falsy `id`, but `name` has a
   fallback chain (`username.split('.')[0]`, else `Channel_<id[0:8]>`) and
   `picture`/`username` are pass-through. `/rest/me` is authorized by
   `r_basicprofile` and carries `vanityName` too, so both old calls collapse into
   one. Needs `LinkedIn-Version` and `X-Restli-Protocol-Version: 2.0.0`, which the
   old `/v2/me` call did not send.
3. **`refreshToken()`** gets the same substitution. Missing this would connect
   fine and then fail at the first token roll (~60 days) — late and silent.
4. **`prompt=none` removed** from `generateAuthUrl`. It suppresses the consent UI,
   which a first-time authorization requires; LinkedIn would return
   `consent_required`. Safe regardless — without it LinkedIn shows consent only
   when it actually needs to.

`checkScopes()` compares requested against granted, so it follows the trimmed
array with no further change.

Only the Page provider is patched. `linkedin.provider.js` (personal profile) has
the same problem and is deliberately left broken — Zablefy posts to the Page.

### Verifying after approval

Confirm the granted scopes really match what was predicted. The CMA endpoints
table lists scopes its endpoints *consume*, which is not strictly the set LinkedIn
*provisions* on the app — the Auth tab's "OAuth 2.0 scopes" panel is ground truth
and stays "No permissions added" until approval. Or probe without touching the UI:

```bash
curl -s "https://www.linkedin.com/oauth/v2/authorization?response_type=code\
&client_id=864258cel0yzlo\
&redirect_uri=https%3A%2F%2Fpostiz.dailylatin.org%2Fintegrations%2Fsocial%2Flinkedin-page\
&state=diag&scope=<one-scope>"
```

- `invalid_scope` — not a valid scope for the app; product not added.
- `unauthorized_scope_error` — recognized but not granted. **Still a failure.**
- reaches `Authorize | LinkedIn` — granted.

A bad `redirect_uri` fails *before* scope evaluation, so any scope error also
confirms the redirect URL is registered.

### On upgrade

```bash
docker compose pull postiz
docker create --name postiz-tmp ghcr.io/gitroomhq/postiz-app:latest
docker cp postiz-tmp:/app/apps/backend/dist/libraries/nestjs-libraries/src/integrations/social/linkedin.page.provider.js /tmp/new.js
docker rm postiz-tmp
diff /tmp/new.js patches/linkedin.page.provider.js.orig
```

Empty diff means the patch still applies cleanly. Otherwise re-derive it from the
new file before starting the stack, and refresh the `.orig`.
