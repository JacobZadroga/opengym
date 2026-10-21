import fs from 'node:fs';
import path from 'node:path';

const CHUNK = 256 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const allowed = name => /^(secret|db\.json(?:\.bak)?|vapid\.json|audit\.log|state-[a-zA-Z0-9_-]+\.json)$/.test(name);

// Retain the upstream document format, including sync revisions and passkey bytes.
// Each document is chunked so a 5 MiB workout history fits within D1's row limit.
export class D1Documents {
  constructor(db, dir) {
    this.db = db;
    this.dir = dir;
    this.saved = new Map();
    this.revision = 0;
  }

  async load() {
    const [meta, docs] = await this.db.batch([
      this.db.prepare('SELECT revision FROM opengym_meta WHERE id = 1'),
      this.db.prepare('SELECT name, part, data FROM opengym_documents ORDER BY name, part')
    ]);
    if (meta.results.length !== 1) throw new Error('Run the D1 migrations before starting openGym');
    this.revision = meta.results[0].revision;
    const pieces = new Map();
    let total = 0;
    for (const row of docs.results) {
      if (!allowed(row.name)) throw new Error('Unexpected D1 document name');
      const parts = pieces.get(row.name) || [];
      if (row.part !== parts.length) throw new Error('Missing D1 document chunk');
      const bytes = Buffer.from(row.data);
      total += bytes.length;
      if (total > MAX_CACHE_BYTES) throw new Error('Instance exceeds the 32 MiB Cloudflare document cache limit');
      parts.push(bytes);
      pieces.set(row.name, parts);
    }
    // Never start a fresh account database if only part of an instance was restored.
    if (pieces.size && (!pieces.has('secret') || !pieces.has('db.json'))) {
      throw new Error('Incomplete D1 instance: secret or account database missing');
    }
    fs.mkdirSync(this.dir, { recursive: true });
    for (const name of fs.readdirSync(this.dir)) {
      if (allowed(name)) fs.unlinkSync(path.join(this.dir, name));
    }
    for (const [name, parts] of pieces) {
      const bytes = Buffer.concat(parts);
      fs.writeFileSync(path.join(this.dir, name), bytes);
      this.saved.set(name, bytes);
    }
  }

  async flush() {
    const current = new Map();
    let total = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!allowed(name)) continue;
      const bytes = fs.readFileSync(path.join(this.dir, name));
      total += bytes.length;
      if (total > MAX_CACHE_BYTES) throw new Error('Instance exceeds the 32 MiB Cloudflare document cache limit');
      current.set(name, bytes);
    }
    const changes = [];
    for (const name of new Set([...this.saved.keys(), ...current.keys()])) {
      const before = this.saved.get(name), after = current.get(name);
      if (before && after && before.equals(after)) continue;
      changes.push(this.db.prepare('DELETE FROM opengym_documents WHERE name = ?').bind(name));
      if (!after) continue;
      for (let offset = 0, part = 0; offset < Math.max(after.length, 1); offset += CHUNK, part++) {
        changes.push(this.db.prepare('INSERT INTO opengym_documents (name, part, data) VALUES (?, ?, ?)')
          .bind(name, part, new Uint8Array(after.subarray(offset, offset + CHUNK))));
      }
    }
    if (!changes.length) return;
    // A D1 batch is transactional: metadata and all changed documents commit together.
    await this.db.batch([
      this.db.prepare('UPDATE opengym_meta SET revision = ? WHERE id = 1').bind(this.revision + 1),
      ...changes
    ]);
    this.revision++;
    this.saved = current;
  }
}
