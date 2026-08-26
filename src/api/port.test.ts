import { test } from 'node:test';
import assert from 'node:assert/strict';

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { nextFree, occupantOf } from './port.ts';

/**
 * A server on a port of the system's choosing, stopped however the test ends.
 * Without a handler it speaks no HTTP at all, which is one of the things being
 * asked about.
 *
 * Every socket is kept and destroyed at the end. `close` waits on connections, and
 * both of the ones made here outlive the answer: fetch pools the socket it got a
 * reply on, and the one it gave up waiting for is still open at the other end.
 */
async function listening(
  handler: http.RequestListener | undefined,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const sockets: net.Socket[] = [];
  const server = handler ? http.createServer(handler) : net.createServer();
  server.on('connection', (socket: net.Socket) => sockets.push(socket));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a port nobody is on is free', async () => {
  // Taken and given back: a port that was bindable a moment ago is the closest
  // thing to one that is certainly nobody's.
  let free = 0;
  await listening(undefined, async (port) => {
    free = port;
  });

  assert.deepEqual(await occupantOf(free), { kind: 'free' });
});

test('a workbench on the port says which home it is serving', async () => {
  await listening(
    (req, res) => {
      assert.equal(req.url, '/health');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, home: '/somewhere/.workbench' }));
    },
    async (port) => {
      assert.deepEqual(await occupantOf(port), {
        kind: 'workbench',
        home: '/somewhere/.workbench',
      });
    },
  );
});

test('anything else on the port is a stranger, not a workbench', async () => {
  await listening(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>someone else</h1>');
    },
    async (port) => {
      assert.deepEqual(await occupantOf(port), { kind: 'stranger' });
    },
  );
});

test('something listening but not answering HTTP is a stranger too', async () => {
  await listening(undefined, async (port) => {
    assert.deepEqual(await occupantOf(port), { kind: 'stranger' });
  });
});

test('the next free port steps over the one that is taken', async () => {
  await listening(undefined, async (port) => {
    const free = await nextFree(port);
    assert.notEqual(free, port, 'the taken port was offered');
    assert.ok(free !== undefined && free > port);
  });
});

test('no free port in the span is said so rather than guessed at', async () => {
  await listening(undefined, async (port) => {
    assert.equal(await nextFree(port, 1), undefined);
  });
});
