import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Build with `npm run cf:check` before this test. This exercises the real bundled
// API in workerd, including filesystem behavior, WebAuthn options, and D1 binding.
test('Cloudflare API commits sync writes, rejects concurrent stale saves, and survives a runtime restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', path.join(root, 'bundle')], { stdio: 'pipe' });
  const options = convertV4MiniflareOptions({
    cf: false,
    modules: true, modulesRoot: path.join(root, 'bundle'), scriptPath: path.join(root, 'bundle/worker.js'),
    compatibilityDate: '2026-10-21', compatibilityFlags: ['nodejs_compat'],
    bindings: { ORIGIN: 'http://localhost:8787', RP_ID: 'localhost' },
    d1Databases: { DB: 'opengym' }, resourcePersistencePath: path.join(root, 'resources'),
    durableObjects: { OPENGYM: { className: 'OpenGym', useSQLite: true } }
  });
  let mf = new Miniflare(options);
  t.after(async () => mf.dispose());
  let db = await mf.getD1Database('DB');
  const schema = fs.readFileSync(new URL('./migrations/0001_documents.sql', import.meta.url), 'utf8')
    .replace(/^--.*$/gm, '').replace(/\n/g, ' ');
  await db.exec(schema);
  const secret = 'integration-key';
  await db.batch([
    db.prepare('INSERT INTO opengym_documents VALUES (?, 0, ?)').bind('secret', [...Buffer.from(secret)]),
    db.prepare('INSERT INTO opengym_documents VALUES (?, 0, ?)').bind('db.json', [...Buffer.from(JSON.stringify({
      users: [{ id: 'tester', name: 'Test', admin: true }], creds: [], subs: [], invites: []
    }))])
  ]);
  const payload = `tester:${Date.now() + 3600000}:0`;
  const token = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const call = (pathname, method = 'GET', body, signed = true) => mf.dispatchFetch('http://localhost:8787' + pathname, {
    method, headers: { Origin: 'http://localhost:8787', 'Content-Type': 'application/json',
      ...(signed ? { Cookie: 'gymsid=' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  assert.equal((await call('/api/health')).status, 200);
  assert.equal((await call('/api/data', 'GET', undefined, false)).status, 401);
  const optionsResponse = await call('/api/register/options', 'POST', { name: 'New person' }, false);
  assert.equal(optionsResponse.status, 200);
  assert.equal((await optionsResponse.json()).options.rp.id, 'localhost');
  assert.equal((await call('/api/data', 'PUT', { baseRev: 0, state: { routines: [], workouts: [] } })).status, 200);
  const concurrent = await Promise.all([
    call('/api/data', 'PUT', { baseRev: 1, state: { routines: [], workouts: [], marker: 'a' } }),
    call('/api/data', 'PUT', { baseRev: 1, state: { routines: [], workouts: [], marker: 'b' } })
  ]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  const before = await (await call('/api/data')).json();
  assert.equal(before.rev, 2);
  assert.equal((await call('/api/push/public-key')).status, 501);
  assert.equal((await call('/api/coach/config')).status, 404);
  await mf.dispose();
  mf = new Miniflare(options);
  db = await mf.getD1Database('DB');
  const after = await (await call('/api/data')).json();
  assert.deepEqual(after, before);
  // Inject a transactional failure. No successful response or stale cached reads
  // may escape after a write that D1 did not acknowledge.
  await db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON opengym_meta BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.equal((await call('/api/data', 'PUT', { baseRev: 2, state: { routines: [], workouts: [], marker: 'lost' } })).status, 503);
  assert.equal((await call('/api/data')).status, 503);
  const chunks = await db.prepare('SELECT data FROM opengym_documents WHERE name = ? ORDER BY part').bind('state-tester.json').all();
  const saved = JSON.parse(Buffer.concat(chunks.results.map(r => Buffer.from(r.data))).toString());
  assert.equal(saved.marker, before.state.marker);
});
