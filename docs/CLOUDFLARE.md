# Deploy openGym on Cloudflare Workers + D1

This fork adds a Cloudflare deployment for personal and small household instances.
The React PWA and exercise catalogue are Worker static assets. Accounts, passkeys,
signed-session secret, workout documents, and audit log persist in D1. A singleton
Durable Object serializes API requests so upstream's document-based account and
sync logic keeps its original behavior across simultaneous devices.

## Supported features and limits

- Passkey registration/login, account management, device pairing, routines,
  workouts, body-weight history, sync conflict detection, and the admin dashboard.
- Guest mode remains local to the browser, as upstream.
- Password login, AI Coach, server push/reminders, and custom photo/video uploads
  are **disabled in this Cloudflare deployment**. Passkeys are required for accounts.
  The ordinary Docker/Node deployment retains these features.
- This is a document adapter, not a relational rewrite. It caches D1 documents in
  the Worker's temporary filesystem and commits changed documents transactionally
  before returning an API response. Temporary files are never the durable copy.
- The full instance has a 32 MiB document-cache limit, including the account DB
  backup. It is intended for a small instance; all API calls share one actor.
  Static assets bypass it. Large installations need a per-account storage design.
- D1 query and Worker resource usage apply. Test your history size before relying
  on the free tier. Each 256 KiB document chunk is one insert when changed.
- Passkey challenges, device pairing codes, and rate-limit counters are temporary;
  a runtime restart may require restarting a login/pairing flow.

## First deployment

Use Node 24 (Node 22.13+ also has the SQLite API needed by storage tests).
Run all commands from the repository root.

```bash
npm ci
npm run cf:install
npx wrangler login
npx wrangler d1 create opengym
```

Edit `wrangler.jsonc`:

1. Replace `database_id` with the UUID returned by `d1 create`.
2. Set `vars.ORIGIN` to your final HTTPS origin, for example
   `https://opengym.YOUR-SUBDOMAIN.workers.dev` or `https://gym.example.com`.
   No trailing slash or subpath.
3. Set `vars.RP_ID` to that hostname only: `opengym.YOUR-SUBDOMAIN.workers.dev`
   or `gym.example.com`. Passkeys bind to this hostname; choose it before signing up.
4. For a new personal instance, set `FIRST_USER_ADMIN` to `"1"`. Register your own
   account immediately after deployment, then set it back to `"0"` and redeploy.
   Keep `"0"` if you do not want the first registered account to become admin.

The defaults are for local development and must be changed before production.
You can find your workers.dev subdomain in the Cloudflare dashboard. If using a
custom domain, attach it to the Worker and set ORIGIN/RP_ID to that domain.

```bash
npm run cf:migrate:remote
npm run cf:deploy
```

Open your HTTPS URL and create your passkey account. The frontend calls `/api`
on the same origin. There is no separate API host or database credential in the
browser. Once you have an admin account, the upstream admin dashboard can create
invites; set `INVITE_ONLY` to `"1"` to require them for additional registrations.

Do not create a second deployment/actor namespace sharing the same database or
use gradual Worker deployments. The revision guard rejects overlapping stale
writers rather than letting them overwrite each other's documents. Use a separate
D1 database and Durable Object namespace for staging.

## Local development and verification

For localhost, use ORIGIN `http://localhost:8787` and RP_ID `localhost` in the local
configuration. Do not use localhost settings on the production deployment.

```bash
npm run cf:migrate:local
npm run cf:build
npm run cf:dev
```

```bash
npm run cf:check
npm run cf:test
npm test --prefix api
```

`cf:check` builds all assets and dry-runs the Worker bundle without deploying.
`cf:test` checks large/Unicode documents, transactional rollback, stale writers,
incomplete restores, the actual API in workerd, simultaneous saves, restart
persistence, authentication refusal, and storage-failure responses.

Validation for this change: Cloudflare's four test cases passed; frontend build
and Worker dry-run passed. The upstream API suite passed 583 tests, failed 10,
and skipped 3. A clean checkout of the same upstream commit produced the same
10 failures (Coach/payload tests); they are not introduced by this port.

## Backups and failures

Use Cloudflare D1 backups/Time Travel or `wrangler d1 export DB --remote` to back up
all tables together. Preserve the session secret and account database together;
restoring only workout documents cannot restore accounts or sessions. Restore
with the application stopped, then deploy a fresh Worker version to reload it.

If a D1 commit fails, the response is 503 and the actor stops serving subsequent
requests. This prevents its modified memory from being mistaken for committed
state. Fix the D1 issue and redeploy to reload the last committed snapshot.
Never delete the D1 database or the `secret` document as a recovery shortcut.

This guide covers a fresh installation. There is no automatic importer for an
existing Docker `data/` directory. Existing users should export their workout
history from the app and import it after creating a passkey on the new hostname.
Custom uploaded media and Coach settings are not imported by this port.
