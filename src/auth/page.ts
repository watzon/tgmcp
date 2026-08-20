export function loginPageHtml(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>tgmcp sign-in</title>
  <style>
    :root {
      --ink: #d7e7c8;
      --muted: #8aa07a;
      --paper: #121a14;
      --panel: #1b261c;
      --line: #2d3d2c;
      --warn: #e2b36b;
      --bad: #d97864;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--paper); color: var(--ink); }
    body {
      font: 16px/1.45 ui-sans-serif, system-ui, sans-serif;
      padding: 40px 22px 64px;
    }
    main { max-width: 28rem; }
    h1 {
      font: 400 2.4rem/0.95 ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, serif;
      letter-spacing: -0.03em;
      margin: 0 0 0.4rem;
    }
    .lede { color: var(--muted); margin: 0 0 1.6rem; }
    #phase {
      font-size: 0.92rem;
      color: var(--warn);
      margin: 0 0 1.4rem;
      min-height: 1.3em;
    }
    label { display: block; margin: 0 0 0.35rem; color: var(--muted); font-size: 0.9rem; }
    input {
      width: 100%;
      margin: 0 0 0.9rem;
      padding: 0.65rem 0.7rem;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--ink);
      font: inherit;
      border-radius: 0;
    }
    input:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
    button {
      appearance: none;
      border: 0;
      background: var(--ink);
      color: var(--paper);
      font: inherit;
      padding: 0.6rem 1rem;
      margin: 0 0.5rem 0.8rem 0;
      cursor: pointer;
    }
    button.secondary { background: transparent; color: var(--ink); border: 1px solid var(--line); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    #err { color: var(--bad); min-height: 1.3em; margin: 0 0 1rem; }
    #qr { display: none; margin: 0.6rem 0 1rem; }
    #qr img { display: block; width: 220px; height: 220px; background: #fff; padding: 8px; }
    .hidden { display: none !important; }
    kbd { font: 0.85em ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>tgmcp</h1>
    <p class="lede">This page stays on 127.0.0.1. API hash, login code, and 2FA never go through the agent.</p>
    <p id="phase"></p>
    <p id="err"></p>

    <form id="creds" class="hidden">
      <label for="apiId">api_id</label>
      <input id="apiId" name="apiId" inputmode="numeric" autocomplete="off" />
      <label for="apiHash">api_hash</label>
      <input id="apiHash" name="apiHash" autocomplete="off" />
      <button type="submit">Save keys</button>
    </form>

    <form id="phone" class="hidden">
      <label for="e164">Phone (E.164)</label>
      <input id="e164" name="phone" placeholder="+15551234567" autocomplete="tel" />
      <button type="submit">Send code</button>
      <button type="button" class="secondary" id="qrStart">Show QR instead</button>
    </form>

    <form id="code" class="hidden">
      <label for="sms">Login code</label>
      <input id="sms" name="code" inputmode="numeric" autocomplete="one-time-code" />
      <label for="pw">2FA password (if you use one)</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" />
      <button type="submit">Sign in</button>
      <button type="button" class="secondary" id="resend">Resend code</button>
    </form>

    <div id="qrbox" class="hidden">
      <p>Scan from Telegram on your phone: Settings → Devices → Link Desktop Device.</p>
      <div id="qr"><img alt="Telegram login QR" /></div>
      <label for="qrpw">2FA password (if you use one)</label>
      <input id="qrpw" type="password" autocomplete="current-password" />
      <button type="button" id="qrAgain">Refresh QR</button>
    </div>

    <p id="done" class="hidden">Signed in. You can close this tab. The MCP server has the session.</p>
  </main>
  <script>
    const token = ${JSON.stringify(token)};
    const err = document.getElementById('err');
    const phaseEl = document.getElementById('phase');

    async function api(path, body) {
      const res = await fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'content-type': 'application/json',
          'x-tgmcp-token': token,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.content || data.error || res.statusText);
      return data;
    }

    function show(id, on) {
      document.getElementById(id).classList.toggle('hidden', !on);
    }

    async function refresh() {
      const data = await api('/api/status');
      const s = data.data;
      phaseEl.textContent = s.phase + '. ' + s.hint;
      err.textContent = s.authError || '';
      show('creds', s.phase === 'need_credentials');
      show('phone', s.phase === 'need_login' || s.phase === 'sending_code');
      show('code', s.phase === 'pending_code');
      show('qrbox', s.phase === 'pending_qr');
      show('done', s.phase === 'ready');
      if (s.phase === 'pending_qr' && s.qrDataUrl) {
        const box = document.getElementById('qr');
        box.style.display = 'block';
        box.querySelector('img').src = s.qrDataUrl;
      }
    }

    document.getElementById('creds').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/credentials', {
          apiId: Number(document.getElementById('apiId').value),
          apiHash: document.getElementById('apiHash').value,
        });
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    document.getElementById('phone').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/send-code', { phone: document.getElementById('e164').value });
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    document.getElementById('code').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/sign-in', {
          code: document.getElementById('sms').value,
          password: document.getElementById('pw').value || undefined,
        });
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    document.getElementById('resend').addEventListener('click', async () => {
      try { await api('/api/resend'); await refresh(); }
      catch (ex) { err.textContent = ex.message; }
    });
    document.getElementById('qrStart').addEventListener('click', async () => {
      try {
        await api('/api/qr', { password: document.getElementById('qrpw').value || undefined });
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });
    document.getElementById('qrAgain').addEventListener('click', async () => {
      try {
        await api('/api/qr', { password: document.getElementById('qrpw').value || undefined });
        await refresh();
      } catch (ex) { err.textContent = ex.message; }
    });

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`
}
