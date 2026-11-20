import { byId } from './dom';
import { getSupabase } from './modules/supabase';
import { visitorId } from './visits';

type Row = { name: string; visitors: number };
type Day = { day: string; visitors: number; signups: number; studiers: number; focus_hours: number };
type Stats = {
    days: number;
    accounts: Record<'total' | 'verified' | 'new' | 'new_verified' | 'signed_in', number>;
    visitors: Record<'today' | 'week' | 'period' | 'all_time' | 'page_views' | 'returning', number>;
    study: Record<'studiers' | 'studiers_all_time' | 'regulars' | 'focus_hours' | 'focus_hours_all_time' | 'sessions' | 'average_minutes'
        | 'rooms' | 'rooms_all_time' | 'tasks' | 'tasks_done' | 'groups_open_now' | 'groups_planned', number>;
    daily: Day[];
    pages: Row[];
    sources: Row[];
    devices: Row[];
};

const message = byId('stats-message');
const number = new Intl.NumberFormat();
const percent = (part: number, whole: number) => whole ? Math.round(part / whole * 100) + '%' : '–';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function tiles(id: string, items: [label: string, value: number | string, note?: string][]) {
    byId(id).replaceChildren(...items.map(([label, value, note]) => {
        const tile = el('div', 'tile');
        tile.append(el('dt', '', label), el('dd', '', typeof value === 'number' ? number.format(value) : value));
        if (note) tile.append(el('dd', 'note', note));
        return tile;
    }));
}

// One small bar chart per measure: a single series each, so no legend; hover or focus shows the value.
function daily(rows: Day[]) {
    const charts: [key: keyof Omit<Day, 'day'>, label: string][] = [['visitors', 'Visitors'], ['signups', 'Sign-ups'], ['studiers', 'People studying'], ['focus_hours', 'Focus hours']];
    const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    byId('stats-daily').replaceChildren(...charts.map(([key, label]) => {
        const max = Math.max(...rows.map(row => row[key]), 1);
        const figure = el('figure', 'chart');
        const bars = el('div', 'bars');
        bars.setAttribute('role', 'img');
        bars.setAttribute('aria-label', `${label} per day, up to ${number.format(max)}`);
        for (const row of rows) {
            const bar = el('span', 'bar');
            bar.style.setProperty('--h', String(row[key] / max));
            bar.dataset.tip = `${date.format(new Date(row.day))}: ${number.format(row[key])}`;
            bars.append(bar);
        }
        figure.append(el('figcaption', '', `${label} · peak ${number.format(max)}`), bars);
        return figure;
    }));
    const head = el('tr');
    ['Day', ...charts.map(([, label]) => label)].forEach(text => head.append(el('th', '', text)));
    byId('stats-table').replaceChildren(head, ...rows.slice().reverse().map(row => {
        const tr = el('tr');
        tr.append(el('td', '', row.day), ...charts.map(([key]) => el('td', '', number.format(row[key]))));
        return tr;
    }));
}

function lists(stats: Stats) {
    const groups: [string, Row[]][] = [['Pages', stats.pages], ['Sources', stats.sources], ['Devices', stats.devices]];
    byId('stats-lists').replaceChildren(...groups.map(([title, rows]) => {
        const box = el('div', 'list');
        box.append(el('h3', '', title));
        const max = Math.max(...rows.map(row => row.visitors), 1);
        const list = el('ol');
        if (!rows.length) list.append(el('li', 'empty', 'No visits yet'));
        for (const row of rows) {
            const item = el('li');
            item.style.setProperty('--w', String(row.visitors / max));
            item.append(el('span', '', row.name), el('strong', '', number.format(row.visitors)));
            list.append(item);
        }
        box.append(list);
        return box;
    }));
}

function render(stats: Stats) {
    const { accounts: a, visitors: v, study: s, days } = stats;
    const period = days === 365 ? 'year' : `${days} days`;
    tiles('stats-accounts', [
        ['Accounts', a.total],
        ['Verified', a.verified, percent(a.verified, a.total) + ' of accounts'],
        [`New, last ${period}`, a.new, `${number.format(a.new_verified)} verified`],
        [`Signed in, last ${period}`, a.signed_in]
    ]);
    tiles('stats-visitors', [
        ['Today', v.today],
        ['Last 7 days', v.week],
        [`Last ${period}`, v.period, `${number.format(v.returning)} came back another day`],
        ['All time', v.all_time],
        [`Page views, last ${period}`, v.page_views, 'Each page once per visitor per day'],
        ['Visitors to accounts', percent(a.new, v.period), `New accounts per visitor, last ${period}`]
    ]);
    tiles('stats-study', [
        [`People studying, last ${period}`, s.studiers, `${number.format(s.regulars)} on 3 or more days`],
        ['Ever studied', s.studiers_all_time, percent(s.studiers_all_time, a.total) + ' of accounts'],
        [`Focus hours, last ${period}`, s.focus_hours, `${number.format(s.focus_hours_all_time)} all time`],
        [`Finished sessions, last ${period}`, s.sessions, `${s.average_minutes} min per saved block`],
        [`Rooms opened, last ${period}`, s.rooms, `${number.format(s.rooms_all_time)} all time`],
        [`Tasks added, last ${period}`, s.tasks, `${percent(s.tasks_done, s.tasks)} done`],
        ['Groups open now', s.groups_open_now, `${number.format(s.groups_planned)} planned`]
    ]);
    daily(stats.daily);
    lists(stats);
}

async function load(days: number) {
    message.textContent = 'Loading…';
    const { data, error } = await getSupabase().rpc('platform_stats', { p_days: days });
    if (error || !data) {
        byId('stats-body').hidden = true;
        message.textContent = /not allowed/i.test(error?.message ?? '') ? 'This page is only for Flow’s owner.' : 'Stats could not be loaded. Try again shortly.';
        return;
    }
    message.textContent = '';
    render(data as Stats);
    byId('stats-body').hidden = false;
}

(async () => {
    const { data } = await getSupabase().auth.getSession();
    if (!data.session) {
        message.replaceChildren('Log in to see stats. ', Object.assign(el('a', '', 'Log in'), { href: '/login.html' }));
        return;
    }
    // Stop counting this browser. Fails quietly for anyone who isn't the owner; platform_stats then refuses them too.
    const visitor = visitorId();
    if (visitor) await getSupabase().rpc('exclude_visitor', { p_visitor: visitor });
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-days]');
    buttons.forEach(button => button.addEventListener('click', () => {
        buttons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
        void load(Number(button.dataset.days));
    }));
    await load(30);
})();
