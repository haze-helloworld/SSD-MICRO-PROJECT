import type { EventPayload, RoomRef, StoredMsg } from '../types.js';
import { refKey } from '../types.js';
import type { Backplane, BackplaneHandlers, HistoryResult } from './index.js';
import { uniqueUsers } from './index.js';

interface RoomData {
  seq: number;
  log: StoredMsg[];
  dedupe: Map<string, { seq: number; exp: number }>;
  presence: Map<string, number>;
}

/**
 * In-process "Redis": several MemoryBackplane instances sharing one MemoryHub behave like a cluster
 * of gateways sharing a backplane. Supports outage simulation (setDown) for deterministic tests.
 * Also the zero-dependency fallback for single-node dev / demo when no Redis is available.
 */
export class MemoryHub {
  rooms = new Map<string, RoomData>();
  subs = new Map<string, Set<MemoryBackplane>>();
  members = new Set<MemoryBackplane>();
  down = false;
  /** test hook: deliveries to these nodes are silently dropped (simulates lost pub/sub messages) */
  muted = new Set<MemoryBackplane>();

  room(ref: RoomRef): RoomData {
    const k = refKey(ref);
    let r = this.rooms.get(k);
    if (!r) this.rooms.set(k, (r = { seq: 0, log: [], dedupe: new Map(), presence: new Map() }));
    return r;
  }

  /** Simulate a Redis outage: commands fail, pub/sub deliveries are dropped. Recovery notifies all nodes. */
  setDown(down: boolean): void {
    if (this.down === down) return;
    this.down = down;
    for (const m of this.members) down ? m.handlers?.onDown() : m.handlers?.onUp();
  }
}

export class MemoryBackplane implements Backplane {
  readonly kind = 'memory';
  handlers: BackplaneHandlers | null = null;
  constructor(private hub: MemoryHub = new MemoryHub(), private maxLen = 2000, private dedupeTtlMs = 300_000) {
    hub.members.add(this);
  }
  get isUp() {
    return !this.hub.down;
  }
  setHandlers(h: BackplaneHandlers) {
    this.handlers = h;
  }
  async start() {}
  async stop() {
    this.hub.members.delete(this);
    for (const s of this.hub.subs.values()) s.delete(this);
  }
  private guard() {
    if (this.hub.down) throw new Error('backplane unavailable');
  }

  async publish(ref: RoomRef, m: { user: string; text: string; cid: string }) {
    this.guard();
    const r = this.hub.room(ref);
    const now = Date.now();
    if (m.cid) {
      const ex = r.dedupe.get(m.cid);
      if (ex && ex.exp > now) return { seq: ex.seq, duplicate: true };
    }
    const seq = ++r.seq;
    const msg: StoredMsg = { t: 'msg', room: ref.room, seq, user: m.user, text: m.text, ts: now, cid: m.cid };
    r.log.push(msg);
    if (r.log.length > this.maxLen) r.log.splice(0, r.log.length - this.maxLen);
    if (m.cid) r.dedupe.set(m.cid, { seq, exp: now + this.dedupeTtlMs });
    for (const b of this.hub.subs.get(refKey(ref)) ?? []) setImmediate(() => !b.hub.down && !b.hub.muted.has(b) && b.handlers?.onMessage(ref, msg));
    return { seq, duplicate: false };
  }

  async publishEvent(ref: RoomRef, ev: EventPayload) {
    this.guard();
    for (const b of this.hub.subs.get(refKey(ref)) ?? []) setImmediate(() => !b.hub.down && !b.hub.muted.has(b) && b.handlers?.onEvent(ref, ev));
  }

  async subscribe(ref: RoomRef) {
    const k = refKey(ref);
    let s = this.hub.subs.get(k);
    if (!s) this.hub.subs.set(k, (s = new Set()));
    s.add(this);
  }
  async unsubscribe(ref: RoomRef) {
    this.hub.subs.get(refKey(ref))?.delete(this);
  }

  async head(ref: RoomRef) {
    this.guard();
    return this.hub.room(ref).seq;
  }

  async history(ref: RoomRef, afterSeq: number, upToSeq: number | undefined, limit: number): Promise<HistoryResult> {
    this.guard();
    const r = this.hub.room(ref);
    const msgs = r.log.filter((m) => m.seq > afterSeq && (upToSeq === undefined || m.seq <= upToSeq)).slice(0, limit);
    return { msgs };
  }

  async presenceSync(ref: RoomRef, localMembers: string[], ttlMs: number) {
    this.guard();
    const r = this.hub.room(ref);
    const now = Date.now();
    for (const m of localMembers) r.presence.set(m, now + ttlMs);
    for (const [m, exp] of r.presence) if (exp <= now) r.presence.delete(m);
    return uniqueUsers([...r.presence.keys()]);
  }
  async presenceRemove(ref: RoomRef, member: string) {
    this.guard();
    this.hub.room(ref).presence.delete(member);
  }
  async presenceList(ref: RoomRef) {
    this.guard();
    const r = this.hub.room(ref);
    const now = Date.now();
    return uniqueUsers([...r.presence].filter(([, exp]) => exp > now).map(([m]) => m));
  }
}
