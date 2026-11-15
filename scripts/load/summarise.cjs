// Turns k6 --summary-export files into one table: node scripts/load/summarise.cjs summary-*.json
const fs = require('fs');
const rows = process.argv.slice(2).map(file => {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')).metrics;
    const v = (name, key) => m[name]?.values?.[key] ?? m[name]?.[key];
    return {
        people: Number((file.match(/(\d+)\.json$/) || [])[1]),
        'joined room': `${v('flow_channel_join_ok', 'passes') ?? 0}`,
        'room_send failed': `${v('flow_rpc_failed', 'passes') ?? 0} of ${(v('flow_rpc_failed', 'passes') ?? 0) + (v('flow_rpc_failed', 'fails') ?? 0)}`,
        'room_send p95': Math.round(v('flow_rpc_ms', 'p(95)') ?? 0) + ' ms',
        'http req/s': (v('http_reqs', 'rate') ?? 0).toFixed(1),
        'delivery p95': Math.round(v('flow_delivery_ms', 'p(95)') ?? 0) + ' ms',
        'msgs in /s': (v('flow_messages_received', 'rate') ?? 0).toFixed(1),
        'board msgs in /s': (v('flow_board_pings_received', 'rate') ?? 0).toFixed(1),
        'sockets dropped': v('flow_sockets_dropped', 'count') ?? 0,
        'join p95': Math.round(v('flow_join_ms', 'p(95)') ?? 0) + ' ms'
    };
}).sort((a, b) => a.people - b.people);
console.table(rows);
