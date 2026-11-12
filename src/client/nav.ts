// The screen you land on after signing in is called Home everywhere. Links
// marked data-home-when-signed-in become "Home" (or the label they name) for
// someone signed in, and keep their signed-out text and address otherwise.
export function homeLinks() {
    let signedIn = false;
    try { signedIn = !!(localStorage.getItem('flow_signed_in') || localStorage.getItem('flow_user')); } catch { /* treated as signed out */ }
    if (!signedIn) return;
    document.querySelectorAll<HTMLAnchorElement>('a[data-home-when-signed-in]').forEach(link => {
        link.href = '/room.html';
        link.textContent = link.dataset.homeWhenSignedIn || 'Home';
    });
    document.querySelectorAll<HTMLElement>('[data-hide-when-signed-in]').forEach(el => el.remove());
}
