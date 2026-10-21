import { DurableObject } from 'cloudflare:workers';
import { handleAsNodeRequest } from 'cloudflare:node';
import { D1Documents } from './storage.js';

const failure = () => Response.json({ error: 'Datastore unavailable. Please retry later.' }, {
  status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '10' }
});

// All callers use the same actor. Its request lock includes the complete Node handler
// and the awaited D1 commit, not merely the synchronous portion of the handler.
export class OpenGym extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.failed = false;
    ctx.blockConcurrencyWhile(async () => {
      try {
        if (!env.ORIGIN || !env.RP_ID) throw new Error('Configure ORIGIN and RP_ID');
        Object.assign(process.env, {
          ORIGIN: env.ORIGIN, RP_ID: env.RP_ID, RP_NAME: env.RP_NAME || 'openGym',
          INVITE_ONLY: env.INVITE_ONLY || '0', FIRST_USER_ADMIN: env.FIRST_USER_ADMIN || '0',
          ALLOW_GUEST: env.ALLOW_GUEST || '1', ADMIN_UIDS: env.ADMIN_UIDS || '',
          DEFAULT_LANG: env.DEFAULT_LANG || '', SESSION_DAYS: env.SESSION_DAYS || '90',
          OPENGYM_CLOUDFLARE: '1', DATA_DIR: '/tmp/opengym', PORT: '3000',
          COACH_DISABLED: '1', MEDIA_UPLOADS: '0', PASSWORD_LOGIN: '0', TRUST_PROXY: '1'
        });
        this.documents = new D1Documents(env.DB, '/tmp/opengym');
        await this.documents.load();
        const { startServer } = await import('../api/server.js');
        await startServer();
        // Persist generated session and VAPID keys before accepting the first request.
        await this.documents.flush();
      } catch (error) {
        console.error('openGym initialization failed', error);
        this.failed = true;
      }
    });
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (this.failed) return failure();
      try {
        const response = await handleAsNodeRequest(3000, request);
        // The Node handler can finish writing after its response headers arrive.
        const body = await response.arrayBuffer();
        await this.documents.flush();
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store');
        return new Response(response.status === 204 || response.status === 304 ? null : body, {
          status: response.status, headers
        });
      } catch (error) {
        // Never continue with an in-memory mutation whose commit failed. A fresh deploy
        // reloads the last committed D1 snapshot. Returning 503 also drops session cookies.
        console.error('openGym request/commit failed; instance stopped', error);
        this.failed = true;
        return failure();
      }
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      // Only Cloudflare's verified address reaches upstream rate limiting/audit code.
      const headers = new Headers(request.headers);
      const address = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
      headers.set('X-Forwarded-For', address);
      headers.set('CF-Connecting-IP', address);
      const stub = env.OPENGYM.get(env.OPENGYM.idFromName('instance'));
      try { return await stub.fetch(new Request(request, { headers })); }
      catch (error) { console.error('openGym actor unavailable', error); return failure(); }
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    return new Response(response.body, { status: response.status, headers });
  }
};
