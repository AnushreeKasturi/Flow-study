// Browser storage can be switched off (site data blocked), and then every call throws, even
// naming localStorage. Flow keeps only conveniences there, so a blocked store reads as empty
// and writes are dropped: the page carries on, it just won't remember.
type Kind = 'local' | 'session';
const store = (kind: Kind) => kind === 'local' ? localStorage : sessionStorage;
export function read(key: string, kind: Kind = 'local'): string | null {
    try { return store(kind).getItem(key); } catch { return null; }
}
// null removes the key.
export function write(key: string, value: string | null, kind: Kind = 'local') {
    try { if (value === null) store(kind).removeItem(key); else store(kind).setItem(key, value); } catch { /* this visit only */ }
}
