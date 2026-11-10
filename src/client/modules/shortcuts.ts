// Single-key room shortcuts. They never fire while the user is typing, has a
// control focused, holds a modifier, or has a dialog open.
export function initShortcuts(actions: Record<string, () => void>) {
    document.addEventListener('keydown', event => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.isComposing) return;
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, select, button, summary, a, [role="button"], [contenteditable]')) return;
        if (!document.getElementById('modal-overlay')!.classList.contains('hidden')) return;
        const action = actions[event.key.toLowerCase()];
        if (!action) return;
        event.preventDefault();
        action();
    });
}
