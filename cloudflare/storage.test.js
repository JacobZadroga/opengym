import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { D1Documents } from './storage.js';

function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(fs.readFileSync(new URL('./migrations/0001_documents.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(query) { return { query, args: [], bind(...args) { this.args = args; return this; } }; },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const result = statements.map(s => ({ results: sql.prepare(s.query).all(...s.args) }));
        sql.exec('COMMIT');
        return result;
      } catch (e) { sql.exec('ROLLBACK'); throw e; }
    }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-d1-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); sql.close(); });
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);
  return { sql, db, dir, write };
}

test('keys and large Unicode workout documents survive a fresh cache; only changed docs are rewritten', async t => {
  const { sql, db, dir, write } = fixture(t);
  const store = new D1Documents(db, dir);
  await store.load();
  write('secret', 'stable-session-key'); write('db.json', '{"users":[]}');
  const state = JSON.stringify({ routines: [], workouts: ['🏋️'.repeat(650000)] });
  write('state-person.json', state);
  await store.flush();
  assert.ok(sql.prepare('SELECT count(*) n FROM opengym_documents WHERE name = ?').get('state-person.json').n > 8);
  await store.flush();
  assert.equal(store.revision, 1);
  const reload = new D1Documents(db, dir);
  await reload.load();
  assert.equal(fs.readFileSync(path.join(dir, 'state-person.json'), 'utf8'), state);
  assert.equal(fs.readFileSync(path.join(dir, 'secret'), 'utf8'), 'stable-session-key');
  fs.unlinkSync(path.join(dir, 'state-person.json'));
  await reload.flush();
  assert.equal(sql.prepare('SELECT count(*) n FROM opengym_documents WHERE name = ?').get('state-person.json').n, 0);
});

test('stale writers and failed batches cannot partially replace committed accounts or workouts', async t => {
  const { sql, db, dir, write } = fixture(t);
  const store = new D1Documents(db, dir);
  await store.load();
  write('secret', 'key'); write('db.json', '{"users":["original"]}');
  await store.flush();
  store.revision = 0;
  write('db.json', '{"users":["stale"]}');
  await assert.rejects(store.flush(), /stale openGym writer/);
  assert.equal(Buffer.from(sql.prepare('SELECT data FROM opengym_documents WHERE name = ?').get('db.json').data).toString(), '{"users":["original"]}');
  store.revision = 1;
  sql.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON opengym_documents BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  await assert.rejects(store.flush(), /injected failure/);
  assert.equal(sql.prepare('SELECT revision FROM opengym_meta').get().revision, 1);
  assert.equal(Buffer.from(sql.prepare('SELECT data FROM opengym_documents WHERE name = ?').get('db.json').data).toString(), '{"users":["original"]}');
});

test('incomplete restores and missing chunks fail closed', async t => {
  const { sql, db, dir } = fixture(t);
  sql.prepare('INSERT INTO opengym_documents VALUES (?, ?, ?)').run('state-person.json', 0, Buffer.from('{}'));
  await assert.rejects(new D1Documents(db, dir).load(), /Incomplete/);
  sql.exec('DELETE FROM opengym_documents');
  sql.prepare('INSERT INTO opengym_documents VALUES (?, ?, ?)').run('db.json', 1, Buffer.from('{}'));
  await assert.rejects(new D1Documents(db, dir).load(), /Missing.*chunk/);
});
