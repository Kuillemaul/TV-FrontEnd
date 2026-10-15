import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { allowedHost, scan, subnetHosts } from './discover.js';

function fake(handler: (path: string) => { status?: number; body: string; headers?: Record<string, string> }): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const r = handler(req.url ?? '/');
      res.writeHead(r.status ?? 200, { 'Content-Type': 'text/html', ...(r.headers ?? {}) });
      res.end(r.body);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: (srv.address() as AddressInfo).port, close: () => srv.close() }));
  });
}
const notFound = { status: 404, body: 'Not found' };

test('finds and recognises services by what they answer, on any port', async () => {
  const servers = await Promise.all([
    fake((p) => (p === '/System/Info/Public' ? { body: JSON.stringify({ ProductName: 'Jellyfin Server', ServerName: 'Basement' }) } : notFound)),
    fake((p) => (p === '/identity' ? { body: '<MediaContainer machineIdentifier="abc"/>' } : notFound)),
    fake((p) => (p === '/' ? { body: '<html><head><title>Radarr</title></head></html>' } : notFound)),
    fake((p) => (p === '/api/serverinfo' ? { status: 401, body: '', headers: { 'WWW-Authenticate': 'Digest realm="tvheadend"' } } : notFound)),
    fake((p) => (p === '/' ? { body: '<title>My NAS dashboard</title>' } : notFound)),
  ]);
  const closed = await fake(() => notFound);
  closed.close();
  try {
    const seen: string[] = [];
    const found = await scan(['127.0.0.1'], { ports: [...servers.map((s) => s.port), closed.port], onFound: (f) => seen.push(f.kind) });
    const byKind = Object.fromEntries(found.map((f) => [f.kind, f]));
    assert.equal(byKind.jellyfin.name, 'Jellyfin · Basement');
    assert.equal(byKind.jellyfin.link, 'jellyfin');
    assert.equal(byKind.jellyfin.url, `http://127.0.0.1:${servers[0].port}`);
    assert.equal(byKind.plex.link, 'plex');
    assert.equal(byKind.radarr.link, 'radarr');
    assert.equal(byKind.tvheadend.link, 'tvheadend');
    assert.equal(byKind.web.name, 'My NAS dashboard');
    assert.equal(byKind.web.link, undefined);
    assert.equal(found.length, 5, 'the closed port finds nothing');
    assert.equal(seen.length, 5);
    assert.equal(found.at(-1)!.kind, 'web', 'linkable apps are listed first');
  } finally {
    for (const s of servers) s.close();
  }
});

test('only scans your own network', () => {
  assert.ok(allowedHost('192.168.1.10'));
  assert.ok(allowedHost('10.0.0.5'));
  assert.ok(allowedHost('nas.lan'));
  assert.ok(!allowedHost('8.8.8.8'));
  assert.ok(!allowedHost('172.32.0.1'));
  assert.ok(!allowedHost('evil host'));
  assert.equal(subnetHosts('192.168.1.20').length, 254);
  assert.equal(subnetHosts('192.168.1.20')[0], '192.168.1.1');
});
