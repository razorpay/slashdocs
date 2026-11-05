import { useSyncExternalStore } from "react";

// A key that the server shows once: the default key of a new bot, or a
// named key. bot is the address of its bot.
export type OneTimeKey = {
  id: number;
  bot: string;
  keyName?: string;
  token: string;
  createdAt: number;
};

// The keys that came and that the reader did not close yet. The app keeps
// them above every page, so that a key shows wherever the reader went while
// it was made. They live only in memory: never in storage, the address, a
// log or the query cache. Thus a reload loses them, and the app warns before
// one.
let keys: OneTimeKey[] = [];
let nextId = 1;
// A sign-out or a change of account starts a new session. A key of a request
// made before it never shows.
let session = 0;
// The account whose keys this tab shows, or null when no one is signed in.
// Keys belong to it: another account never sees them.
let account: string | null | undefined;
const listeners = new Set<() => void>();

function set(next: OneTimeKey[]) {
  keys = next;
  listeners.forEach((listener) => listener());
}

// keepOneTimeKey waits for a request that makes a key, and keeps the key that
// key(result) gives. It keeps it before any page hears of the result, so that
// no page that went away can lose it.
export async function keepOneTimeKey<T>(
  request: Promise<T>,
  key: (result: T) => Pick<OneTimeKey, "bot" | "keyName" | "token">,
): Promise<T> {
  const started = session;
  const result = await request;
  if (started === session)
    set([...keys, { ...key(result), id: nextId++, createdAt: Date.now() }]);
  return result;
}

// closeOneTimeKey forgets a key that the reader copied or chose to lose.
export const closeOneTimeKey = (id: number) => set(keys.filter((k) => k.id !== id));

// clearOneTimeKeys forgets every key, and every key that a request made
// before now gives later. Sign-out calls it.
export function clearOneTimeKeys() {
  session++;
  set([]);
}

// setKeyAccount tells the account that this tab shows. A new account, as
// after a sign-in in another tab, forgets the keys of the one before.
export function setKeyAccount(next: string | null) {
  if (account !== undefined && next !== account) clearOneTimeKeys();
  account = next;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

// The keys that wait for the reader, the oldest first.
export const useOneTimeKeys = () => useSyncExternalStore(subscribe, () => keys);

// The CLI takes its server and token from SLASHDOCS_SERVER and SLASHDOCS_TOKEN,
// so a headless agent needs no browser login.
export function headlessCLI(url: string, token: string) {
  return `export SLASHDOCS_SERVER=${url}
export SLASHDOCS_TOKEN=${token}
slashdocs docs create report.html`;
}
