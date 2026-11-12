// Reads "/remind ..." commands. No network and no AI: the common forms are few
// and predictable, so they are handled here, instantly.
//   /remind 20m stretch            /remind in 1h 30m send the email
//   /remind at 18:30 call home     /remind at 6pm call home
//   /remind break drink water      /remind at the next focus block start the essay
export type Trigger = 'break' | 'focus';
export interface ReminderRequest { text: string; at?: number; trigger?: Trigger; }

const MAX_MINUTES = 24 * 60;

export function parseRemind(input: string, now = Date.now()): ReminderRequest | null {
    let rest = input.replace(/^\/remind(?:\s+me)?\s*/i, '').trim();
    const take = (pattern: RegExp) => {
        const match = rest.match(pattern);
        if (match) rest = rest.slice(match[0].length).trim();
        return match;
    };
    const finish = (request: Omit<ReminderRequest, 'text'>) => {
        const text = rest.replace(/^(?:to|that|about|:|-)\s+/i, '').trim().slice(0, 120);
        return text ? { ...request, text } : null;
    };

    // Timer-linked: the next break, or the next focus block.
    if (take(/^(?:at\s+|on\s+|in\s+|after\s+)?(?:the\s+)?(?:next\s+)?(?:break|short break|long break)\b/i)) return finish({ trigger: 'break' });
    if (take(/^(?:at\s+|when\s+|after\s+)?(?:the\s+)?(?:next\s+)?focus(?:\s+block)?(?:\s+starts)?\b/i)) return finish({ trigger: 'focus' });
    if (take(/^(?:after|at the end of)\s+(?:this|the)\s+(?:block|session|focus(?: block)?)\b/i)) return finish({ trigger: 'break' });

    // A clock time today, or tomorrow if it has passed: 18:30, 6pm, 6:15 pm.
    const clock = take(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    if (clock) {
        let hours = Number(clock[1]);
        const minutes = Number(clock[2] ?? 0);
        const half = clock[3]?.toLowerCase();
        if (half === 'pm' && hours < 12) hours += 12;
        if (half === 'am' && hours === 12) hours = 0;
        if (hours > 23 || minutes > 59) return null;
        const when = new Date(now);
        when.setHours(hours, minutes, 0, 0);
        if (when.getTime() <= now) when.setDate(when.getDate() + 1);
        return finish({ at: when.getTime() });
    }

    // A duration: 20m, 20 min, 1h30m, 1 hour 15 minutes, half an hour.
    let minutes = 0;
    take(/^in\s+/i);
    if (take(/^(?:half an hour|30 ?mins?)\b/i)) minutes = 30;
    else {
        const duration = take(/^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(?:m|min|mins|minutes?))?\b/i);
        if (duration && (duration[1] || duration[2])) minutes = Math.round(Number(duration[1] ?? 0) * 60 + Number(duration[2] ?? 0));
    }
    if (minutes < 1 || minutes > MAX_MINUTES) return null;
    return finish({ at: now + minutes * 60000 });
}

// "in 20 min", "at 6:30 PM", "at the next break": how a reminder is described back.
export function describeWhen(request: Pick<ReminderRequest, 'at' | 'trigger'>, now = Date.now()) {
    if (request.trigger === 'break') return 'at the next break';
    if (request.trigger === 'focus') return 'when the next focus block starts';
    const minutes = Math.round(((request.at ?? now) - now) / 60000);
    const time = new Date(request.at ?? now).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return minutes < 60 ? `in ${Math.max(1, minutes)} min (${time})` : `at ${time}`;
}
