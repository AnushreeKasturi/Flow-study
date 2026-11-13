// The one place an HTML string becomes part of the page. Everything passed here
// is built by Flow itself, with anything that came from another person already
// run through escapeHTML. The Content-Security-Policy requires Trusted Types, so
// assigning a string to innerHTML anywhere else throws instead of rendering.
type Policy = { createHTML(html: string): string };
const policy = (window as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createHTML(html: string): string }): Policy } })
    .trustedTypes?.createPolicy('flow-markup', { createHTML: html => html });

export function setMarkup(element: Element, html: string) {
    element.innerHTML = policy ? policy.createHTML(html) : html;
}
