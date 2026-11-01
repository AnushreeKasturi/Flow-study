// Required template elements fail clearly if a component loses its contract.
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing Flow element: ' + id);
    return element as T;
}
