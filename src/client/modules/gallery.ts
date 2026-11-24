// The biggest tiles that fit a space, as video-call galleries do: try every column count,
// and keep the one whose tiles come out widest once both the width and the height of the
// space, and the tiles' shape, have had their say.
export function fitGallery(count: number, width: number, height: number, gap: number, ratio = 4 / 3) {
    let best = { columns: 1, tileWidth: 0 };
    for (let columns = 1; columns <= Math.max(1, count); columns++) {
        const rows = Math.max(1, Math.ceil(count / columns));
        const tileWidth = Math.floor(Math.min((width - gap * (columns - 1)) / columns, ((height - gap * (rows - 1)) / rows) * ratio));
        if (tileWidth > best.tileWidth) best = { columns, tileWidth };
    }
    return best;
}
