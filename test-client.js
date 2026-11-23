// Локальная проверка сервера: VLESS over WS → example.com:80, ждём HTTP 200.
// Запуск: node test-client.js [ws://127.0.0.1:3100/ws]
'use strict';
const net = require('net');
const crypto = require('crypto');

const url = new URL(process.argv[2] || 'ws://127.0.0.1:3100/ws');
const UUID = '3f9a1c72-5b84-4e0d-9a1f-7c2e8b6d4f03'.replace(/-/g, '');

function frame(opcode, payload) {
  const mask = crypto.randomBytes(4);
  const n = payload.length;
  let head;
  if (n < 126) { head = Buffer.alloc(2); head[1] = 0x80 | n; }
  else { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
  head[0] = 0x80 | opcode;
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

function readFrames(buf) {
  const out = [];
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) break;
    out.push({ opcode, payload: buf.subarray(off, off + len) });
    buf = buf.subarray(off + len);
  }
  return { out, rest: buf };
}

const host = 'example.com';
const req = Buffer.from(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
const addr = Buffer.from(host);
const header = Buffer.concat([
  Buffer.from([0]),                       // version
  Buffer.from(UUID, 'hex'),               // uuid
  Buffer.from([0]),                       // addon len
  Buffer.from([1]),                       // cmd TCP
  Buffer.from([0, 80]),                   // port
  Buffer.from([2, addr.length]), addr,    // domain
  req,                                    // initial payload
]);

const sock = net.connect(Number(url.port || 80), url.hostname, () => {
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(
    `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n` +
    `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
});
let buf = Buffer.alloc(0), handshaken = false, got = Buffer.alloc(0);
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const at = buf.indexOf('\r\n\r\n');
    if (at < 0) return;
    const head = buf.subarray(0, at).toString();
    if (!head.includes('101')) { console.log('НЕ 101:', head.split('\r\n')[0]); process.exit(1); }
    buf = buf.subarray(at + 4);
    handshaken = true;
    sock.write(frame(2, header));
  }
  const { out, rest } = readFrames(buf);
  buf = rest;
  for (const f of out) {
    if (f.opcode === 1) { console.log('серверная ошибка:', f.payload.toString()); process.exit(1); }
    if (f.opcode === 2) got = Buffer.concat([got, f.payload]);
  }
  if (got.length > 20) {
    const text = got.toString('latin1');
    console.log(text.split('\r\n')[0] || 'нет строки ответа');
    console.log(text.includes('200 OK') || text.includes('301') || text.includes('200') ? 'ПРОЙДЕНО' : 'НЕ ПРОЙДЕНО');
    sock.destroy();
    process.exit(0);
  }
});
sock.on('error', (e) => { console.log('ошибка:', e.message); process.exit(1); });
setTimeout(() => { console.log('таймаут, байт:', got.length); process.exit(2); }, 20000);
