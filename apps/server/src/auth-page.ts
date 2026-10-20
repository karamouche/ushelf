/**
 * Server-rendered pages shown before the reader loads: browser sign-in and connector consent.
 * Both are served under a CSP that only allows inline styles, so the stylesheet is embedded.
 */

const AUTH_PAGE_CSS = `
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #fff;
  color: #111;
  font: 15px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
main {
  width: min(360px, calc(100% - 40px));
  padding: 32px 0;
}
h1 {
  margin: 0 0 24px;
  font-size: 44px;
  font-weight: 650;
  letter-spacing: -0.05em;
  line-height: 1;
}
h1 span {
  font-family: Georgia, serif;
  font-style: italic;
  font-weight: 400;
}
p {
  margin: 0 0 16px;
  color: #777;
}
strong {
  color: #111;
}
ul {
  color: #777;
  padding-left: 20px;
}
label {
  display: block;
  margin: 36px 0 4px;
  color: #777;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 0;
  border: 0;
  border-bottom: 1px solid #dedede;
  border-radius: 0;
  background: transparent;
  font: inherit;
  outline: none;
  caret-color: #111;
  transition: border-color 0.2s;
}
input:focus {
  border-color: #111;
}
input[type="password"] {
  font-size: 22px;
  letter-spacing: 0.3em;
}
button {
  width: 100%;
  padding: 13px;
  margin-top: 28px;
  border: 1px solid #111;
  background: #111;
  color: #fff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}
button:hover {
  opacity: 0.85;
}
/* Dim the primary action until something has been typed; the placeholder is a single space. */
form:has(input:placeholder-shown) button:not(.secondary) {
  opacity: 0.35;
}
button.secondary {
  margin-top: 10px;
  background: transparent;
  color: #111;
  border-color: #dedede;
}
.error {
  padding-left: 10px;
  border-left: 2px solid #a00;
  color: #a00;
}
.warning {
  color: #7a4b00;
}
`;

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Shared shell for the server-rendered sign-in and connector consent pages. */
export function authPageHtml(title: string, body: string): string {
  return [
    '<!doctype html><html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)} · uShelf</title>`,
    `<style>${AUTH_PAGE_CSS}</style>`,
    "</head><body><main>",
    "<h1><span>u</span>Shelf</h1>",
    body,
    "</main></body></html>",
  ].join("");
}

/** An announced error message; `message` is escaped. */
export function errorAlertHtml(message: string): string {
  return `<p class="error" role="alert">${escapeHtml(message)}</p>`;
}

export function loginPageHtml(action: string, nextPath: string, error?: string): string {
  return authPageHtml(
    "Sign in",
    [
      "<p>Enter your password to open your library.</p>",
      error ? errorAlertHtml(error) : "",
      `<form method="post" action="${escapeHtml(action)}">`,
      `<input type="hidden" name="next" value="${escapeHtml(nextPath)}">`,
      '<label for="password">Password</label>',
      '<input id="password" name="password" type="password" autocomplete="current-password" placeholder=" " required autofocus>',
      '<button type="submit">Sign in</button>',
      "</form>",
    ].join(""),
  );
}
