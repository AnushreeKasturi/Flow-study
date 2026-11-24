import { gsap } from 'gsap';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Short answers to something the user just did: a dialog opening, the room appearing, a tab switching.
export function reveal(element: HTMLElement, kind: 'dialog' | 'room' | 'panel' = 'panel') {
    if (reduced()) return;
    gsap.fromTo(element, { y: kind === 'panel' ? 0 : 8, opacity: .65 }, {
        y: 0, opacity: 1, duration: kind === 'room' ? .3 : .18,
        ease: 'power2.out', overwrite: true, clearProps: 'transform,opacity'
    });
}

export function clearMotion(element: Element) {
    gsap.killTweensOf(element);
    gsap.set(element, { clearProps: 'transform,opacity' });
}

export function completeTask(element: Element) {
    if (reduced()) return;
    gsap.fromTo(element, { scale: .86 }, { scale: 1, duration: .24, ease: 'back.out(1.6)', clearProps: 'transform', overwrite: true });
    // A few small suns float up from the box and fade: a tiny reward for finishing something.
    const box = element.getBoundingClientRect();
    for (let i = 0; i < 7; i++) {
        const sun = document.body.appendChild(Object.assign(document.createElement('i'), { className: 'task-sun' }));
        gsap.set(sun, { left: box.left + box.width / 2, top: box.top + box.height / 2, scale: .4 + Math.random() * .6 });
        gsap.to(sun, {
            x: (Math.random() - .5) * 70, y: -36 - Math.random() * 46, opacity: 0, duration: .75 + Math.random() * .35,
            ease: 'power2.out', onComplete: () => sun.remove()
        });
    }
}

// Preference changes take effect during the current visit, including open dialogs.
matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
    if (!event.matches) return;
    gsap.globalTimeline.getChildren().forEach(tween => tween.progress(1));
});
