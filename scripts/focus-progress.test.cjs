const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { transpileModule, ModuleKind } = require('typescript');
const source = transpileModule(readFileSync('src/client/modules/focus-progress.ts', 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText;
let instance = 0;
const load = () => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + instance++);

test('live focus survives pause and resume and excludes paused time', async () => {
    const focus = await load();
    const start = new Date(2026, 9, 30, 12).getTime();
    focus.startFocus(start);
    focus.startFocus(start + 1000);
    assert.equal(focus.getLiveFocus({ now: start + 60000 }).todaySeconds, 60);
    focus.pauseFocus(start + 60000);
    assert.equal(focus.getLiveFocus({ now: start + 120000 }).totalSeconds, 60);
    focus.startFocus(start + 120000);
    assert.equal(focus.getLiveFocus({ now: start + 150000 }).totalSeconds, 90);
});

test('completion reconciles a saved row without double counting live focus', async () => {
    const focus = await load();
    const start = Date.now();
    focus.startFocus(start);
    const session = focus.finishFocus(start + 61000);
    assert.equal(session.seconds, 61);
    assert.equal(focus.getLiveFocus({ now: start + 62000 }).totalSeconds, 61);
    assert.equal(focus.getLiveFocus({ persistedIds: [session.id], now: start + 62000 }).totalSeconds, 0);
    focus.confirmFocus(session.id);
    assert.equal(focus.getLiveFocus({ now: start + 62000 }).totalSeconds, 0);
});

test('today only counts the part of a live interval after local midnight', async () => {
    const focus = await load();
    const before = new Date(2026, 9, 30, 23, 59, 30).getTime();
    focus.startFocus(before);
    assert.deepEqual(focus.getLiveFocus({ now: before + 90000 }), { totalSeconds: 90, todaySeconds: 60 });
});

test('stepping away pauses focus time, and the room keeps none of it', async () => {
    const focus = await load();
    const start = Date.now();
    focus.resetBlock(start);
    focus.startFocus(start);
    focus.setFocusAway(true, start + 60000);
    focus.startFocus(start + 90000); // a checkpoint carrying on must not restart the clock while away
    assert.equal(focus.getLiveFocus({ now: start + 300000 }).totalSeconds, 60);
    focus.setFocusAway(false);
    focus.startFocus(start + 300000);
    assert.equal(focus.getLiveFocus({ now: start + 330000 }).totalSeconds, 90);
});

test('time in the current block survives saves, and counts only from the block start', async () => {
    const focus = await load();
    const start = Date.now();
    focus.startFocus(start);
    focus.resetBlock(start + 30000); // a new block starts while already focusing
    focus.finishFocus(start + 330000); // the five-minute checkpoint
    focus.startFocus(start + 330000);
    assert.equal(focus.blockSeconds(start + 630000), 600);
    focus.resetBlock(start + 630000);
    assert.equal(focus.blockSeconds(start + 690000), 60);
});
