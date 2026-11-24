const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { transpileModule, ModuleKind } = require('typescript');
const source = transpileModule(readFileSync('src/client/modules/gallery.ts', 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText;
const load = () => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('tiles take the layout that makes them biggest, within both width and height', async () => {
    const { fitGallery } = await load();
    // The stage from a 1440×900 window: about 624 wide and 620 tall.
    assert.deepEqual(fitGallery(1, 624, 620, 14), { columns: 1, tileWidth: 624 }, 'One person fills the width');
    assert.deepEqual(fitGallery(2, 624, 620, 14), { columns: 1, tileWidth: 404 }, 'Two stack when that makes them bigger than side by side (305)');
    assert.deepEqual(fitGallery(2, 1100, 500, 14), { columns: 2, tileWidth: 543 }, 'A wide stage puts two side by side');
    assert.equal(fitGallery(6, 624, 620, 14).columns, 2, 'Six on a squarish stage: two columns of three');
    const { columns, tileWidth } = fitGallery(4, 900, 600, 14);
    const rows = Math.ceil(4 / columns);
    assert(tileWidth * columns + 14 * (columns - 1) <= 900 && (tileWidth * 3 / 4) * rows + 14 * (rows - 1) <= 600, 'Never larger than the space');
    assert.deepEqual(fitGallery(0, 624, 620, 14), { columns: 1, tileWidth: 624 }, 'No tiles yet is not an error');
});
