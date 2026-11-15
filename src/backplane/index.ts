import type { EventPayload, RoomRef, StoredMsg } from '../types.js';

export interface BackplaneHandlers {
  /** A sequenced chat message arrived on a subscribed room channel (at-most-once, may be missing seqs). */
  onMessage(ref: RoomRef, msg: StoredMsg): void;
  /** Ephemeral event (presence / typing). */
  onEvent(ref: RoomRef, ev: EventPayload): void;
  /** Backplane (re)connected and all subscriptions are active again -> gateway should catch up from the log. */
  onUp(): void;
  onDown(): void;
}

export interface HistoryResult {
  msgs: StoredMsg[];
}

/**
 * The abstraction the gateway programs against.
 * Implementations: RedisBackplane (ElastiCache / Redis Cloud / Upstash / local) and MemoryBackplane (dev, tests, single node fallback).
 *
 * Guarantees every implementation must provide:
 *  - publish() assigns a per-room gap-free sequence number and appends to a replayable log atomically with fan-out
 *  - publish() is idempotent for the same (room, cid) within the dedupe window
 *  - history() returns log entries with afterSeq < seq <= upToSeq in order
 */
export interface Backplane {
  readonly kind: string;
  readonly isUp: boolean;
  setHandlers(h: BackplaneHandlers): void;
  start(): Promise<void>;
  stop(): Promise<void>;

  publish(ref: RoomRef, m: { user: string; text: string; cid: string }): Promise<{ seq: number; duplicate: boolean }>;
  publishEvent(ref: RoomRef, ev: EventPayload): Promise<void>;
  subscribe(ref: RoomRef): Promise<void>;
  unsubscribe(ref: RoomRef): Promise<void>;
  head(ref: RoomRef): Promise<number>;
  history(ref: RoomRef, afterSeq: number, upToSeq: number | undefined, limit: number): Promise<HistoryResult>;

  /** Refresh presence for local members, prune expired, return the cluster-wide unique user list. */
  presenceSync(ref: RoomRef, localMembers: string[], ttlMs: number): Promise<string[]>;
  presenceRemove(ref: RoomRef, member: string): Promise<void>;
  presenceList(ref: RoomRef): Promise<string[]>;

  saveSecret(key: string, value: string, ttlSec: number): Promise<void>;
  loadSecret(key: string): Promise<string | null>;
}

/** presence member format: `<user>#<connId>` */
export const memberUser = (m: string): string => m.slice(0, m.lastIndexOf('#'));
export const uniqueUsers = (members: string[]): string[] => [...new Set(members.map(memberUser))].sort();
