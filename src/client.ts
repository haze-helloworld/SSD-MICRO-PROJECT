import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { ServerFrame, StoredMsg } from './types.js';

export interface ClientOpts {
  /** One URL (e.g. the NLB DNS name) or several (client-side fallback list). Example: ws://host:8080/ws */
  urls: string[];
  token: string;
  rooms: string[];
  maxBackoffMs?: number;
  sendTimeoutMs?: number; // retransmit if no ack
  sendDeadlineMs?: number; // give up after this long
}

interface RoomState {
  lastSeq: number;
  pending: Map<number, StoredMsg>;
  joined: boolean;
  everJoined: boolean;
}

interface Pending {
  room: string;
  text: string;
  cid: string;
  resolve: (v: { seq: number; dup: boolean }) => void;
  reject: (e: Error) => void;
  deadline: number;
  lastTx: number;
}

/**
 * Client half of the delivery guarantee.
 *  - tracks lastSeq per room, de-duplicates and re-orders (holds back out-of-order seqs until the hole is repaired)
 *  - reconnects with jittered exponential backoff and RESUMES every room from lastSeq
 *  - sends with an idempotency key (cid) and retransmits until acked -> at-least-once send + server dedupe = exactly-once effect
 * Events: 'msg' (StoredMsg, deduped + ordered), 'gap', 'open', 'close', 'members', 'presence', 'typing', 'error_frame'
 */
export class ResilientClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private rooms = new Map<string, RoomState>();
  private pending = new Map<string, Pending>();
  private closedByUser = false;
  private attempt = 0;
  private urlIdx = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout;
  node = '';
  reconnects = 0;
  gaps = 0;

  constructor(private o: ClientOpts) {
    super();
    for (const r of o.rooms) this.rooms.set(r, { lastSeq: 0, pending: new Map(), joined: false, everJoined: false });
    this.tick = setInterval(() => this.retransmit(), 250);
    this.tick.unref();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
  lastSeq(room: string): number {
    return this.rooms.get(room)?.lastSeq ?? 0;
  }
  joinedAll(): boolean {
    return [...this.rooms.values()].every((r) => r.joined);
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    this.open();
    return this.waitFor(() => this.joinedAll(), 10_000);
  }

  waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (cond()) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(iv);
          reject(new Error('waitFor timeout'));
        }
      }, 10);
    });
  }

  close(): void {
    this.closedByUser = true;
    clearInterval(this.tick);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const p of this.pending.values()) p.reject(new Error('client closed'));
    this.pending.clear();
    this.ws?.close();
  }

  /** Abruptly drop the TCP connection (test hook). */
  kill(): void {
    this.ws?.terminate();
  }

  send(room: string, text: string): Promise<{ seq: number; dup: boolean }> {
    const cid = randomUUID();
    return new Promise((resolve, reject) => {
      const p: Pending = { room, text, cid, resolve, reject, deadline: Date.now() + (this.o.sendDeadlineMs ?? 30_000), lastTx: 0 };
      this.pending.set(cid, p);
      this.transmit(p);
    });
  }

  // ---------------------------------------------------------------- internals
  private open() {
    const url = `${this.o.urls[this.urlIdx++ % this.o.urls.length]}?token=${encodeURIComponent(this.o.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.emit('open');
    });
    ws.on('message', (d) => this.onFrame(ws, JSON.parse(d.toString()) as ServerFrame));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', () => undefined); // 'close' follows
    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      if (res.statusCode === 401 || res.statusCode === 403) {
        this.closedByUser = true;
        this.emit('error_frame', { t: 'error', code: 'unauthorized', message: 'token rejected' });
      }
    });
  }

  private onClose(ws: WebSocket) {
    if (this.ws !== ws) return;
    for (const r of this.rooms.values()) r.joined = false;
    this.emit('close');
    if (this.closedByUser) return;
    this.reconnects++;
    const base = Math.min(this.o.maxBackoffMs ?? 1500, 50 * 2 ** this.attempt++);
    const delay = Math.random() * base + 20; // full jitter -> no thundering herd on a surviving node
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  private raw(f: object) {
    if (this.connected) this.ws!.send(JSON.stringify(f));
  }

  private joinRoom(room: string) {
    const s = this.rooms.get(room)!;
    // brand-new joiner: no lastSeq (server replays recent history). Returning/resuming joiner: send lastSeq.
    this.raw(s.everJoined || s.lastSeq > 0 ? { t: 'join', room, lastSeq: s.lastSeq } : { t: 'join', room });
  }

  private onFrame(ws: WebSocket, f: ServerFrame) {
    if (this.ws !== ws) return;
    switch (f.t) {
      case 'welcome':
        this.node = f.node;
        for (const room of this.rooms.keys()) this.joinRoom(room);
        break;
      case 'joined': {
        const s = this.rooms.get(f.room);
        if (!s) break;
        if (f.truncated || s.lastSeq === 0) s.lastSeq = Math.max(s.lastSeq, f.from - 1);
        s.joined = true;
        s.everJoined = true;
        this.drain(f.room);
        this.emit('members', f.room, f.members);
        for (const p of this.pending.values()) if (p.room === f.room) this.transmit(p); // retransmit unacked after (re)join
        break;
      }
      case 'msg':
        this.onMsg(f);
        break;
      case 'ack': {
        const p = this.pending.get(f.cid);
        if (p) {
          this.pending.delete(f.cid);
          p.resolve({ seq: f.seq, dup: f.dup });
        }
        break;
      }
      case 'error':
        // 'unavailable' / 'rate_limited' / 'not_joined' are transient: the retransmit loop will resend with the same cid.
        if (f.code === 'forbidden' && f.cid) {
          const p = this.pending.get(f.cid);
          if (p) {
            this.pending.delete(f.cid);
            p.reject(new Error(f.code));
          }
        }
        this.emit('error_frame', f);
        break;
      case 'members':
        this.emit('members', f.room, f.members);
        break;
      case 'presence':
        this.emit('presence', f);
        break;
      case 'typing':
        this.emit('typing', f);
        break;
      case 'reconnect':
        ws.close();
        break;
    }
  }

  private onMsg(m: StoredMsg) {
    const s = this.rooms.get(m.room);
    if (!s || m.seq <= s.lastSeq) return; // duplicate
    if (m.seq === s.lastSeq + 1) {
      s.lastSeq = m.seq;
      this.emit('msg', m);
      this.drain(m.room);
      return;
    }
    // hole: hold it back and ask the server to replay from lastSeq (idempotent join == resume)
    s.pending.set(m.seq, m);
    if (s.joined) {
      this.gaps++;
      this.emit('gap', m.room, s.lastSeq, m.seq);
      s.joined = false; // until the server answers with `joined`
      this.joinRoom(m.room);
    }
  }

  private drain(room: string) {
    const s = this.rooms.get(room)!;
    for (;;) {
      const next = s.pending.get(s.lastSeq + 1);
      if (!next) break;
      s.pending.delete(next.seq);
      s.lastSeq = next.seq;
      this.emit('msg', next);
    }
    for (const seq of s.pending.keys()) if (seq <= s.lastSeq) s.pending.delete(seq);
  }

  private transmit(p: Pending) {
    const s = this.rooms.get(p.room);
    if (!this.connected || !s?.joined) return;
    p.lastTx = Date.now();
    this.raw({ t: 'msg', room: p.room, text: p.text, cid: p.cid });
  }

  private retransmit() {
    const now = Date.now();
    for (const p of [...this.pending.values()]) {
      if (now > p.deadline) {
        this.pending.delete(p.cid);
        p.reject(new Error('send deadline exceeded'));
      } else if (now - p.lastTx > (this.o.sendTimeoutMs ?? 800)) {
        this.transmit(p);
      }
    }
  }
}
