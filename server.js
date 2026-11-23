// VLESS over WebSocket на чистом Node.js — без зависимостей.
// Порт из Node-сервиса Northflank публикуется как HTTPS-порт; WebSocket через него работает.
// Протокол VLESS: [ver][uuid 16][addonLen][addons][cmd][port 2][addrType][addr][payload]

'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const UUID_HEX = (process.env.VLESS_UUID || '3f9a1c72-5b84-4e0d-9a1f-7c2e8b6d4f03').replace(/-/g, '');
const UUID = Buffer.from(UUID_HEX, 'hex');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PORT = Number(process.env.PORT || 3000);
const WS_PATH = process.env.WS_PATH || '/ws';

function sendFrame(sock, opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.alloc(2); head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = 0x80 | opcode;
  sock.write(Buffer.concat([head, payload]));
}

function parseFrame(state) {
  // Возвращает [{opcode, payload}] и оставляет хвост в state.buf.
  const out = [];
  while (state.buf.length >= 2) {
    const b0 = state.buf[0], b1 = state.buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (state.buf.length < 4) break;
      len = state.buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (state.buf.length < 10) break;
      len = Number(state.buf.readBigUInt64BE(2)); off = 10;
    }
    if (state.buf.length < off + (masked ? 4 : 0) + len) break;
    let mask = null;
    if (masked) {
      mask = state.buf.subarray(off, off + 4); off += 4;
    }
    const payload = Buffer.from(state.buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    state.buf = state.buf.subarray(off + len);

    if (opcode === 0x8) { state.closed = true; out.push({ opcode: 8, payload }); continue; }
    if (opcode === 0x9) { sendFrame(state.sock, 0xa, payload); continue; }
    if (opcode === 0xa) continue;

    if (opcode === 0x0) {
      state.frag.push(payload);
      if (fin) { out.push({ opcode: state.fragOpcode, payload: Buffer.concat(state.frag) }); state.frag = []; }
      continue;
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (!fin) { state.fragOpcode = opcode; state.frag = [payload]; continue; }
      out.push({ opcode, payload });
    }
  }
  return out;
}

function parseVless(data) {
  if (data.length < 18 || data[0] !== 0) throw new Error('bad vless header');
  if (!data.subarray(1, 17).equals(UUID)) throw new Error('bad uuid');
  const addonLen = data[17];
  let i = 18 + addonLen;
  if (data.length <= i) throw new Error('no cmd');
  const cmd = data[i++];
  if (cmd !== 1) throw new Error('only tcp cmd, got ' + cmd);
  if (data.length < i + 3) throw new Error('short addr');
  const port = data.readUInt16BE(i); i += 2;
  const type = data[i++];
  let host;
  if (type === 1) {
    if (data.length < i + 4) throw new Error('short ipv4');
    host = [...data.subarray(i, i + 4)].join('.'); i += 4;
  } else if (type === 2) {
    const l = data[i++];
    if (data.length < i + l) throw new Error('short domain');
    host = data.subarray(i, i + l).toString('utf8'); i += l;
  } else if (type === 3) {
    if (data.length < i + 16) throw new Error('short ipv6');
    const b = data.subarray(i, i + 16); i += 16;
    const parts = [];
    for (let k = 0; k < 16; k += 2) parts.push(b.readUInt16BE(k).toString(16));
    host = parts.join(':');
  } else throw new Error('bad addr type ' + type);
  return { host, port, rest: data.subarray(i) };
}

function handleSocket(sock, req) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  const state = { sock, buf: Buffer.alloc(0), frag: [], fragOpcode: 0, closed: false };
  let remote = null;
  let queue = [];

  sock.on('data', (chunk) => {
    state.buf = Buffer.concat([state.buf, chunk]);
    const frames = parseFrame(state);
    // parseFrame пишет ответы на ping через sock, состояние хранится в state
    for (const f of frames) {
      if (f.opcode === 8) { if (remote) remote.destroy(); sock.end(); return; }
      if (f.opcode === 1) { continue; }
      if (f.opcode === 2) {
        if (!remote) {
          let target;
          try { target = parseVless(f.payload); }
          catch (e) { sendFrame(sock, 0x1, Buffer.from('ERR: ' + e.message)); sock.end(); return; }
          remote = net.connect(target.port, target.host);
          remote.on('connect', () => {
            sendFrame(sock, 0x2, Buffer.from([0, 0]));
            if (target.rest.length) remote.write(target.rest);
            for (const q of queue) remote.write(q);
            queue = [];
          });
          remote.on('data', (d) => { if (!sock.destroyed) sendFrame(sock, 0x2, d); });
          remote.on('error', () => { if (!sock.destroyed) sock.end(); });
          remote.on('close', () => { if (!sock.destroyed) sock.end(); });
        } else if (remote.writable) remote.write(f.payload);
        else queue.push(f.payload);
      }
    }
  });

  sock.on('close', () => { if (remote) remote.destroy(); });
  sock.on('error', () => { if (remote) remote.destroy(); });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok\n'); return; }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('vless-ws ok\n');
});

server.on('upgrade', (req, sock) => {
  const path = (req.url || '').split('?')[0];
  if (path !== WS_PATH) { sock.destroy(); return; }
  handleSocket(sock, req);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`vless-ws listening :${PORT} path ${WS_PATH} uuid ${UUID_HEX}`);
});
