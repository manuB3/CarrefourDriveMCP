/** Minimal HTML for the OAuth consent page. No script, no external resource. */

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface LoginPageOptions {
  requestId?: string;
  clientName?: string;
  error?: string;
}

export function loginPage({ requestId, clientName, error }: LoginPageOptions): string {
  const who = clientName ? escape(clientName) : 'An MCP client';
  const form = requestId
    ? `<form method="post" action="/oauth/login" autocomplete="off">
        <input type="hidden" name="request" value="${escape(requestId)}">
        <label for="password">Server password</label>
        <input id="password" name="password" type="password" required autofocus autocomplete="current-password">
        <button type="submit">Allow access</button>
      </form>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Carrefour Drive MCP</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --card: #fff; --fg: #1d1d1b; --muted: #6b6b66; --accent: #1f5fd6; --err: #b3261e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #141413; --card: #1f1f1d; --fg: #ececea; --muted: #a3a39e; --accent: #7aa7ff; --err: #ff8a80; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 380px; background: var(--card); border-radius: 14px; padding: 28px 24px; box-shadow: 0 1px 3px rgb(0 0 0 / .12); }
  h1 { font-size: 1.25rem; margin: 0 0 6px; }
  p { margin: 0 0 20px; color: var(--muted); }
  label { display: block; font-weight: 600; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 12px; font-size: 16px; border-radius: 8px; border: 1px solid var(--muted); background: transparent; color: inherit; }
  button { width: 100%; margin-top: 16px; padding: 12px; font-size: 16px; font-weight: 600; border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  .error { color: var(--err); margin: 0 0 16px; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Carrefour Drive MCP</h1>
  <p>${who} wants to use your Carrefour account through this server.</p>
  ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
  ${form}
</main>
</body>
</html>`;
}
