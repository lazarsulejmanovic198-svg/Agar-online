const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const WORLD_SIZE = 5500;
const MAX_CELLS = 64;
const ROOM_CODE = process.env.GAME_ROOM || crypto.randomBytes(9).toString('hex');
const players = new Map();
const sockets = new Map();

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function worldSnapshot() {
  return Array.from(players.values())
    .filter(p => sockets.has(p.id))
    .map(p => ({ id: p.id, name: p.name, color: p.color, cells: p.cells }));
}

function broadcast(data) {
  for (const ws of sockets.values()) send(ws, data);
}

function broadcastWorld() {
  broadcast({ type: 'world', players: worldSnapshot() });
}

function validName(input) { return String(input || 'Igrač').replace(/[\u0000-\u001f]/g, '').slice(0, 12) || 'Igrač'; } function validPlayer(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.cells)) return null;
  const cells = input.cells.slice(0, MAX_CELLS);
  if (cells.some(c => !c || !Number.isFinite(c.x) || !Number.isFinite(c.y) ||
      !Number.isFinite(c.m) || c.x < 0 || c.x > WORLD_SIZE ||
      c.y < 0 || c.y > WORLD_SIZE || c.m <= 0 || c.m > 1000000)) return null;
  const name = validName(input.name);
  const color = /^hsl\(\d{1,3},100%,50%\)$/.test(input.color) ? input.color : 'hsl(140,100%,50%)';
  return { name, color, cells: cells.map(c => ({ x: c.x, y: c.y, m: c.m })) };
}

function resolvePlayerCollisions() {
  const active = Array.from(players.values()).filter(p => p.active);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      for (let ai = 0; ai < a.cells.length && b.active; ai++) {
        const ca = a.cells[ai];
        for (let bi = 0; bi < b.cells.length; bi++) {
          const cb = b.cells[bi];
          const ra = Math.sqrt(ca.m) * 5, rb = Math.sqrt(cb.m) * 5;
          if (ca.m > cb.m * 1.10 && Math.hypot(ca.x - cb.x, ca.y - cb.y) < ra - rb * 0.4) {
            ca.m += cb.m;
            b.cells.splice(bi, 1);
            send(sockets.get(a.id), { type: 'eat', eaterId: a.id, eaterCell: ai, victimId: b.id, victimCell: bi, mass: cb.m });
            send(sockets.get(b.id), { type: 'eat', eaterId: a.id, eaterCell: ai, victimId: b.id, victimCell: bi, mass: cb.m });
            if (!b.cells.length) b.active = false;
            bi--;
          }
        }
      }
      for (let bi = 0; bi < b.cells.length && a.active; bi++) {
        const cb = b.cells[bi];
        for (let ai = 0; ai < a.cells.length; ai++) {
          const ca = a.cells[ai];
          const rb = Math.sqrt(cb.m) * 5, ra = Math.sqrt(ca.m) * 5;
          if (cb.m > ca.m * 1.10 && Math.hypot(cb.x - ca.x, cb.y - ca.y) < rb - ra * 0.4) {
            cb.m += ca.m;
            a.cells.splice(ai, 1);
            send(sockets.get(b.id), { type: 'eat', eaterId: b.id, eaterCell: bi, victimId: a.id, victimCell: ai, mass: ca.m });
            send(sockets.get(a.id), { type: 'eat', eaterId: b.id, eaterCell: bi, victimId: a.id, victimCell: ai, mass: ca.m });
            if (!a.cells.length) a.active = false;
            ai--;
          }
        }
      }
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }
  if (req.method !== 'GET' || (url.pathname !== '/' && url.pathname !== '/index.html')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  if (url.searchParams.get('room') !== ROOM_CODE) {
    res.writeHead(302, { Location: `/?room=${encodeURIComponent(ROOM_CODE)}`, 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) {
      console.error('Ne mogu da učitam index.html:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Greška pri učitavanju igre.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  });
});

const wsServer = new WebSocketServer({ noServer: true, maxPayload: 16384 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/game' || url.searchParams.get('room') !== ROOM_CODE) {
    socket.destroy();
    return;
  }
  wsServer.handleUpgrade(req, socket, head, ws => wsServer.emit('connection', ws, req));
});

wsServer.on('connection', ws => {
  if (sockets.size >= 2) {
    send(ws, { type: 'full' });
    ws.close(1008, 'Host je pun');
    return;
  }
  const id = crypto.randomUUID();
  sockets.set(id, ws);
  players.set(id, { id, name: 'Igrač', color: 'hsl(140,100%,50%)', cells: [], active: false });
  send(ws, { type: 'welcome', id, players: worldSnapshot() });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (err) { console.warn('Odbijena je neispravna poruka klijenta.'); return; }
    const player = players.get(id);
    if (!player) return;
    if (msg.type === 'join') { player.name = validName(msg.name); broadcastWorld(); return; } if (msg.type === 'spawn' || msg.type === 'state') {
      const next = validPlayer(msg.player);
      if (!next || (msg.type === 'state' && !player.active)) return;
      Object.assign(player, next, { active: true });
      if (msg.type === 'spawn') broadcastWorld();
      return;
    }
    if (msg.type === 'leave') {
      player.active = false;
      player.cells = [];
      broadcastWorld();
    }
  });

  ws.on('close', () => {
    sockets.delete(id);
    players.delete(id);
    broadcastWorld();
  });
  ws.on('error', err => console.error('WebSocket greška:', err.message));
});

setInterval(() => {
  resolvePlayerCollisions();
  broadcastWorld();
}, 50);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Host radi na http://localhost:${PORT}/?room=${ROOM_CODE}`);
  console.log('Za brata prosledi javnu IP adresu ili domen uz isti /?room= kod.');
  console.log('Na ruteru je potrebno proslediti TCP port ' + PORT + ' ka ovom računaru.');
});
