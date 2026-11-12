// Runs before first paint on every page, from <head>. Kept as a file (not inline)
// so the Content-Security-Policy can forbid inline scripts entirely.
(function () {
    var page = document.currentScript && document.currentScript.dataset.page;
    try {
        // Apply the saved sky before anything is drawn.
        var sky = localStorage.getItem('flow_theme');
        if (sky) document.documentElement.dataset.theme = sky;

        // A plain flag; the session itself is Supabase's. flow_user is the older form, cleared on the next page that reads the session.
        var signedIn = !!(localStorage.getItem('flow_signed_in') || localStorage.getItem('flow_user'));
        // The room needs an account; an invite code rides along to login and back.
        if (page === 'room' && !signedIn) location.replace('/login.html' + location.search);
        if (page === 'login' && signedIn) location.replace('/room.html' + location.search);
        if (page === 'home') {
            // Invite links used to be /?room=CODE; keep them working.
            if (/[?&]room=/.test(location.search)) location.replace('/room.html' + location.search);
            // The opening plays once per browser session.
            if (sessionStorage.getItem('flow_intro')) document.documentElement.classList.add('intro-seen');
            else sessionStorage.setItem('flow_intro', '1');
        }
    } catch (e) { /* Storage blocked: pages still work, without these conveniences. */ }
})();
