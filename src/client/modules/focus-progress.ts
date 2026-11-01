// Unsaved local focus, shared by the room card and profile summary.
type Segment = { start: number; end: number };
let segments: Segment[] = [];
let activeStart: number | null = null;
const pending = new Map<string, Segment[]>();

export function startFocus(now = Date.now()) {
    if (activeStart === null) activeStart = now;
}

export function pauseFocus(now = Date.now()) {
    if (activeStart !== null && now > activeStart) segments.push({ start: activeStart, end: now });
    activeStart = null;
}

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
