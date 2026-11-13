// Online play. One player hosts a room and shares its code; friends join with the code.
// Connections are peer-to-peer WebRTC data channels, brokered by the public PeerJS server.
// The host runs the whole match (bots, tide, loot, health) and streams it to everyone else.
import { Peer } from 'peerjs';

const PREFIX = 'floodline-r1-';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const NET_VERSION = 1;

function peerOptions() {
  const o = {
    debug: 1,
    config: {
      iceServers: [
        { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    },
  };
  // A local signalling server can be used for testing: ?peer=host:port
  const m = /[?&]peer=([^&]+)/.exec(location.search);
  if (m) {
    const [host, port] = decodeURIComponent(m[1]).split(':');
    Object.assign(o, { host, port: Number(port) || 9000, path: '/', secure: false });
  }
  return o;
}

function makeCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

function waitOpen(peer, ms) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout')), ms);
    peer.once('open', (id) => { clearTimeout(to); resolve(id); });
    peer.once('error', (err) => { clearTimeout(to); reject(err); });
  });
}

export class NetSession {
  constructor() {
    this.role = null;
    this.peer = null;
    this.conns = new Map();
    this.hostConn = null;
    this.myHid = 0;
    this.nextHid = 1;
    this.code = '';
    this.lobby = { players: [], mode: 'a1', pref: 'versus', difficulty: 'regular' };
    this.inMatch = false;
    this.onMessage = null;
    this.onLobby = null;
    this.onStatus = null;
    this.onClosed = null;
    this.onPeerLeft = null;
  }

  get active() { return !!this.role; }

  status(text, kind) { if (this.onStatus) this.onStatus(text, kind); }

  async host(name, lobby) {
    this.close();
    Object.assign(this.lobby, lobby);
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = makeCode();
      const peer = new Peer(PREFIX + code, peerOptions());
      try {
        await waitOpen(peer, 12000);
        this.peer = peer;
        this.code = code;
        break;
      } catch (err) {
        peer.destroy();
        if (!(err && err.type === 'unavailable-id')) throw err;
      }
    }
    if (!this.peer) throw new Error('Could not create a room');
    this.role = 'host';
    this.myHid = 0;
    this.nextHid = 1;
    this.lobby.players = [{ hid: 0, name }];
    this.peer.on('connection', (conn) => this.accept(conn));
    this.peer.on('disconnected', () => { try { this.peer.reconnect(); } catch (e) { /* reconnect is best effort */ } });
    this.emitLobby();
    return this.code;
  }

  accept(conn) {
    conn.on('data', (d) => this.fromClient(conn, d));
    conn.on('close', () => this.dropClient(conn));
    conn.on('error', () => this.dropClient(conn));
  }

  fromClient(conn, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      if (d.v !== NET_VERSION) { conn.send({ t: 'deny', reason: 'Your game version is different from the host’s. Update both copies.' }); return; }
      if (this.inMatch) { conn.send({ t: 'deny', reason: 'That room is already in a match. Ask the host to go back to the lobby.' }); return; }
      if (this.lobby.players.length >= 8) { conn.send({ t: 'deny', reason: 'That room is full (8 players).' }); return; }
      const hid = this.nextHid++;
      conn.hid = hid;
      this.conns.set(hid, conn);
      this.lobby.players.push({ hid, name: String(d.name || 'Player').slice(0, 16) });
      conn.send({ t: 'welcome', hid, code: this.code });
      this.emitLobby();
      return;
    }
    if (conn.hid === undefined) return;
    if (this.onMessage) this.onMessage(d, conn.hid);
  }

  dropClient(conn) {
    if (conn.hid === undefined || !this.conns.has(conn.hid)) return;
    this.conns.delete(conn.hid);
    const p = this.lobby.players.find((x) => x.hid === conn.hid);
    this.lobby.players = this.lobby.players.filter((x) => x.hid !== conn.hid);
    if (this.onPeerLeft) this.onPeerLeft(conn.hid, p ? p.name : 'A player');
    this.emitLobby();
  }

  async join(code, name) {
    this.close();
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 5) throw new Error('Room codes have 5 characters.');
    const peer = new Peer(undefined, peerOptions());
    await waitOpen(peer, 12000);
    this.peer = peer;
    const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('No room answered with that code. Check it and try again.')), 15000);
      peer.once('error', (err) => {
        clearTimeout(to);
        reject(new Error(err && err.type === 'peer-unavailable' ? 'No room found with that code.' : 'Could not connect: ' + (err && err.type ? err.type : err)));
      });
      conn.once('open', () => { clearTimeout(to); resolve(); });
    });
    this.hostConn = conn;
    this.role = 'client';
    this.code = code;
    const welcome = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('The host did not respond.')), 10000);
      this._welcome = (d) => { clearTimeout(to); if (d.t === 'deny') reject(new Error(d.reason)); else resolve(d); };
    });
    conn.on('data', (d) => {
      if (!d || typeof d !== 'object') return;
      if (this._welcome && (d.t === 'welcome' || d.t === 'deny')) { const w = this._welcome; this._welcome = null; w(d); return; }
      if (d.t === 'lobby') { this.lobby = d.lobby; if (this.onLobby) this.onLobby(this.lobby); return; }
      if (this.onMessage) this.onMessage(d, 0);
    });
    conn.on('close', () => { if (this.role === 'client') { const cb = this.onClosed; this.close(); if (cb) cb('The host closed the room.'); } });
    conn.on('error', () => {});
    conn.send({ t: 'hello', v: NET_VERSION, name });
    const w = await welcome;
    this.myHid = w.hid;
    return this.myHid;
  }

  emitLobby() {
    if (this.role !== 'host') return;
    this.broadcast({ t: 'lobby', lobby: this.lobby });
    if (this.onLobby) this.onLobby(this.lobby);
  }

  setLobby(patch) {
    Object.assign(this.lobby, patch);
    this.emitLobby();
  }

  send(msg) {
    if (this.role === 'client' && this.hostConn && this.hostConn.open) this.hostConn.send(msg);
  }

  sendTo(hid, msg) {
    const c = this.conns.get(hid);
    if (c && c.open) c.send(msg);
  }

  broadcast(msg, exceptHid) {
    if (this.role !== 'host') return;
    for (const [hid, c] of this.conns) if (hid !== exceptHid && c.open) c.send(msg);
  }

  close() {
    this.role = null;
    this.inMatch = false;
    for (const c of this.conns.values()) { try { c.close(); } catch (e) { /* closing anyway */ } }
    this.conns.clear();
    if (this.hostConn) { try { this.hostConn.close(); } catch (e) { /* closing anyway */ } }
    this.hostConn = null;
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* closing anyway */ } }
    this.peer = null;
  }
}
