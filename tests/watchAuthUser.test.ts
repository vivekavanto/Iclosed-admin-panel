import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as tick } from 'node:timers/promises';
import type { User, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { watchAuthUser } from '../src/lib/watchAuthUser.ts';
import { moduleIds } from '../src/lib/staffAccess.ts';

type Auth = Parameters<typeof watchAuthUser>[0];
const staff = (modules: string[]) => ({ email: 'clerk@navawilson.law', email_confirmed_at: '2026-10-22T00:00:00Z', app_metadata: { staff_modules: modules } } as User);
function source(initial: User | null) {
  let current = initial;
  let handler: (event: AuthChangeEvent, session: Session | null) => void = () => {};
  let dispatching = false;
  let reads = 0;
  let unsubscribed = false;
  let read = async () => ({ data: { user: current }, error: null });
  const auth = {
    getUser: async () => { assert.equal(dispatching, false, 'Auth requests must run outside the locked callback'); ++reads; return read(); },
    onAuthStateChange: (callback: typeof handler) => { handler = callback; return { data: { subscription: { unsubscribe: () => { unsubscribed = true; } } } }; },
  } as unknown as Auth;
  return {
    auth, setUser: (user: User | null) => { current = user; },
    setRead: (fn: typeof read) => { read = fn; },
    emit: (event: AuthChangeEvent, user: User | null) => { dispatching = true; handler(event, user ? { user } as Session : null); dispatching = false; },
    get reads() { return reads; }, get unsubscribed() { return unsubscribed; },
  };
}

test('a refresh reads new grants and a late cached INITIAL_SESSION cannot remove them', async () => {
  const src = source(staff(['legal-assistant', 'finance']));
  let latest: User | null = null;
  const stop = watchAuthUser(src.auth, user => { latest = user; });
  await tick(5);
  src.emit('INITIAL_SESSION', staff([]));
  assert.deepEqual(moduleIds(latest), ['legal-assistant', 'finance']);
  assert.equal(src.reads, 1);
  stop();
});

test('later token events re-read Auth outside its lock, including revoked grants', async () => {
  const src = source(staff(['finance']));
  let latest: User | null = null;
  const stop = watchAuthUser(src.auth, user => { latest = user; });
  await tick(5);
  src.setUser(staff([]));
  src.emit('TOKEN_REFRESHED', staff(['finance']));
  await tick(5);
  assert.deepEqual(moduleIds(latest), []);
  assert.equal(src.reads, 2);
  stop();
});

test('a stale sign-in event cannot restore cached permissions after owner revocation', async () => {
  const src = source(staff([]));
  let latest: User | null = null;
  const stop = watchAuthUser(src.auth, user => { latest = user; });
  await tick(5);
  src.emit('SIGNED_IN', staff(['legal-assistant', 'finance']));
  await tick(5);
  assert.deepEqual(moduleIds(latest), []);
  stop();
});

test('logout wins over an in-flight user read', async () => {
  const src = source(null);
  let finish!: (value: { data: { user: User | null }; error: null }) => void;
  src.setRead(() => new Promise(resolve => { finish = resolve; }));
  const seen: (User | null)[] = [];
  const stop = watchAuthUser(src.auth, user => seen.push(user));
  src.emit('SIGNED_OUT', null);
  finish({ data: { user: staff(['finance']) }, error: null });
  await tick(5);
  assert.deepEqual(seen, [null]);
  stop();
});

test('network failures fail closed and disposal cancels pending event work', async () => {
  const src = source(staff(['finance']));
  src.setRead(async () => { throw new Error('offline'); });
  const seen: (User | null)[] = [];
  const stop = watchAuthUser(src.auth, user => seen.push(user));
  await tick(5);
  assert.deepEqual(seen, [null]);
  src.emit('SIGNED_IN', staff(['finance']));
  stop();
  await tick(5);
  assert.equal(src.reads, 1);
  assert.equal(src.unsubscribed, true);
});
