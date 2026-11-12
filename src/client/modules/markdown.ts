// A small, safe subset of Markdown for chat: paragraphs, numbered and bulleted
// lists, **bold**, *italic*, `code`, code blocks, and links to http(s) sites.
// Everything is built as DOM nodes with text set as text, never parsed as HTML,
// so a message (from the assistant or from anyone in the room) cannot inject markup.
const MAX_DEPTH = 3;

function inline(text: string, depth = 0): Node[] {
    const nodes: Node[] = [];
    // Order matters: code first (its contents are literal), then links, then emphasis.
    const pattern = /(`[^`\n]+`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,!?;:])|(\*\*([^*]+?)\*\*|__([^_]+?)__)|(\*([^*\s][^*\n]*?)\*|(?<![\w])_([^_\s][^_\n]*?)_(?![\w]))/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        if (match.index! > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
        last = match.index! + match[0].length;
        if (match[1]) nodes.push(Object.assign(document.createElement('code'), { textContent: match[1].slice(1, -1) }));
        else if (match[2]) nodes.push(link(match[4], match[3], depth));
        else if (match[5]) nodes.push(link(match[5], match[5], depth));
        else if (match[6]) nodes.push(wrap('strong', match[7] ?? match[8], depth));
        else nodes.push(wrap('em', match[10] ?? match[11], depth));
    }
    if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
    return nodes;
}

function wrap(tag: 'strong' | 'em', content: string, depth: number) {
    const el = document.createElement(tag);
    if (depth < MAX_DEPTH) el.append(...inline(content, depth + 1)); else el.textContent = content;
    return el;
}

function link(href: string, label: string, depth: number) {
    // Only ever a real web address; anything else stays as plain text.
    let url: URL | null = null;
    try { url = new URL(href); } catch { /* not a URL */ }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return document.createTextNode(label);
    const a = Object.assign(document.createElement('a'), { href: url.href, target: '_blank', rel: 'noopener noreferrer nofollow' });
    if (depth < MAX_DEPTH && label !== href) a.append(...inline(label, depth + 1)); else a.textContent = label;
    return a;
}

export function renderMarkdown(source: string): DocumentFragment {
    const out = document.createDocumentFragment();
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    let paragraph: string[] = [];
    let list: HTMLOListElement | HTMLUListElement | null = null;

    const flushParagraph = () => {
        if (!paragraph.length) return;
        const p = document.createElement('p');
        // Single line breaks inside a paragraph are kept (the message is shown with pre-wrap).
        p.append(...inline(paragraph.join('\n')));
        out.append(p);
        paragraph = [];
    };
    const flushList = () => { if (list) out.append(list); list = null; };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Fenced code block: everything up to the closing fence is shown exactly.
        if (/^\s*```/.test(line)) {
            flushParagraph(); flushList();
            const code: string[] = [];
            while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
            const pre = document.createElement('pre');
            pre.append(Object.assign(document.createElement('code'), { textContent: code.join('\n') }));
            out.append(pre);
            continue;
        }
        const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
        if (ordered || bullet) {
            flushParagraph();
            const tag = ordered ? 'OL' : 'UL';
            if (!list || list.tagName !== tag) {
                flushList();
                list = document.createElement(ordered ? 'ol' : 'ul');
                if (ordered && ordered[1] !== '1') (list as HTMLOListElement).start = Number(ordered[1]);
            }
            const item = document.createElement('li');
            item.append(...inline((ordered ? ordered[2] : bullet![1]).trim()));
            list.append(item);
            continue;
        }
        if (!line.trim()) { flushParagraph(); flushList(); continue; }
        flushList();
        // A heading line reads as a bold lead-in; chat has no use for sizes.
        const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (heading) { flushParagraph(); const p = document.createElement('p'); p.append(wrap('strong', heading[1], 0)); out.append(p); continue; }
        paragraph.push(line);
    }
    flushParagraph(); flushList();
    return out;
}
