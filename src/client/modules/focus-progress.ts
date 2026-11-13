// Unsaved local focus, shared by the room card and profile summary.
type Segment = { start: number; end: number };
let segments: Segment[] = [];
let activeStart: number | null = null;
const pending = new Map<string, Segment[]>();
// Stepped away: time stops counting until you're back, whatever the room's clock does.
let away = false;
// Time you were present in the room's current focus block, across saves, so a block
// you were there for most of counts as a session even if you joined late.
let blockMs = 0;
let blockFrom = 0;

export function startFocus(now = Date.now()) {
    if (activeStart === null && !away) activeStart = now;
}

export function pauseFocus(now = Date.now()) {
    if (activeStart !== null && now > activeStart) {
        segments.push({ start: activeStart, end: now });
        blockMs += Math.max(0, now - Math.max(activeStart, blockFrom));
    }
    activeStart = null;
}

export function setFocusAway(on: boolean, now = Date.now()) {
    if (on) pauseFocus(now);
    away = on;
}

export function resetBlock(now = Date.now()) { blockMs = 0; blockFrom = now; }
export const blockSeconds = (now = Date.now()) =>
    Math.floor((blockMs + (activeStart === null ? 0 : Math.max(0, now - Math.max(activeStart, blockFrom)))) / 1000);

export function getLiveFocus({ persistedIds = [], now = Date.now() }: { persistedIds?: string[]; now?: number } = {}) {
    const saved = new Set(persistedIds);
    const intervals = [...segments];
    if (activeStart !== null) intervals.push({ start: activeStart, end: now });
    for (const [id, batch] of pending) if (!saved.has(id)) intervals.push(...batch);
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    let total = 0, today = 0;
    for (const { start, end } of intervals) {
        total += Math.max(0, end - start);
        today += Math.max(0, end - Math.max(start, day.getTime()));
    }
    return { totalSeconds: Math.floor(total / 1000), todaySeconds: Math.floor(today / 1000) };
}

export function finishFocus(now = Date.now()) {
    pauseFocus(now);
    const batch = segments;
    segments = [];
    const seconds = Math.floor(batch.reduce((sum, part) => sum + part.end - part.start, 0) / 1000);
    if (!seconds) return null;
    const id = crypto.randomUUID();
    pending.set(id, batch);
    return { id, seconds, completedAt: new Date(now).toISOString() };
}

export function confirmFocus(id: string) { pending.delete(id); }
