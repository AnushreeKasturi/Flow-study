import { reveal, clearMotion } from '../motion';
import { byId } from '../dom';
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let returnFocus: HTMLElement | null = null;
const overlay = () => byId<HTMLElement>('modal-overlay');

export function notify(message: string, kind: 'info' | 'error' = 'info') {
    const toast = byId<HTMLElement>('toast');
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.dataset.kind = kind;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), kind === 'error' ? 8000 : 4500);
}

export function openModal(id: string) {
    const container = overlay();
    if (!container) return;
    if (container.classList.contains('hidden')) returnFocus = document.activeElement as HTMLElement | null;
    container.querySelectorAll('.modal').forEach(modal => modal.classList.toggle('hidden', modal.id !== id));
    container.classList.remove('hidden');
    reveal(byId(id), 'dialog');
    byId<HTMLElement>('app').inert = true;
    requestAnimationFrame(() => byId(id).querySelector<HTMLElement>('input, button, a')?.focus());
}

export function closeModal() {
    const container = overlay();
    container.classList.add('hidden');
    container.querySelectorAll('.modal').forEach(modal => { clearMotion(modal); modal.classList.add('hidden'); });
    byId<HTMLElement>('app').inert = false;
    returnFocus?.focus();
}

export function initDialogs() {
    document.addEventListener('keydown', event => {
        const container = overlay();
        if (container.classList.contains('hidden')) return;
        const modal = container.querySelector('.modal:not(.hidden)');
        if (!modal) return;
        if (event.key === 'Escape' && modal.id !== 'join-modal') {
            event.preventDefault();
            closeModal();
        }
        if (event.key === 'Tab') {
            const controls = [...modal.querySelectorAll<HTMLElement>('a[href], button, input, select, [tabindex]')]
                .filter(el => !el.hasAttribute('disabled') && el.tabIndex >= 0 && el.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !modal.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first)?.focus();
            }
        }
    });
    openModal('join-modal');
}
