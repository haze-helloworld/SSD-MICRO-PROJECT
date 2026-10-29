/** Shared protocol + domain types. */

export interface RoomRef {
  tenant: string;
  room: string;
}

export interface StoredMsg {
  t: 'msg';
  room: string;
  seq: number; // per-room, gap-free, monotonically increasing (assigned atomically in Redis)
  user: string;
  text: string;
  ts: number; // server-side publish time (ms)
  cid: string; // client message id (idempotency key)
}

/** Tenant / room / user identifiers are strictly validated: they become part of Redis keys & channels. */
export const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const USER_RE = /^[A-Za-z0-9_.-]{1,32}$/;

export const refKey = (r: RoomRef): string => `${r.tenant}/${r.room}`;

// ---- client -> server frames
export type ClientFrame =
  | { t: 'join'; room: string; lastSeq?: number } // also acts as "resume" when already joined
  | { t: 'leave'; room: string }
  | { t: 'msg'; room: string; text: string; cid?: string }
  | { t: 'typing'; room: string }
  | { t: 'ping' };

// ---- server -> client frames
export type ServerFrame =
  | { t: 'welcome'; user: string; tenant: string; node: string; connId: string }
  | { t: 'joined'; room: string; head: number; from: number; truncated: boolean; members: string[] }
  | StoredMsg
  | { t: 'ack'; cid: string; seq: number; dup: boolean }
  | { t: 'presence'; room: string; user: string; state: 'join' | 'leave'; from?: string }
  | { t: 'members'; room: string; members: string[] }
  | { t: 'typing'; room: string; user: string; from?: string }
  | { t: 'error'; code: string; message: string; cid?: string; room?: string }
  | { t: 'reconnect' }
  | { t: 'pong' };

export type EventPayload =
  | { t: 'presence'; room: string; user: string; state: 'join' | 'leave'; from?: string }
  | { t: 'typing'; room: string; user: string; from?: string };
