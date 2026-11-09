// The spike's three owner pages: /setup (enrol the passkey), /admin (sign in, open a pairing
// window) and /consent/<uid> (approve one authorization). Plain HTML with inline script, no
// third-party resources (§4.5). Passkeys use the browser's JSON helpers
// (PublicKeyCredential.parse*OptionsFromJSON, credential.toJSON()).

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `<style>
body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.45;color:#111;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input,select{background:#222;color:#eee}}
button{font-size:1rem;padding:.6rem 1.1rem;margin:.3rem .3rem .3rem 0;cursor:pointer}
input,select{font-size:1rem;padding:.4rem;margin:.2rem 0 .8rem;width:100%;box-sizing:border-box}
.host{font-size:1.8rem;font-weight:700;word-break:break-all}.muted{opacity:.7;font-size:.9rem}
pre{white-space:pre-wrap;word-break:break-all;background:rgba(127,127,127,.15);padding:.8rem}
</style>`;

const page = (title: string, body: string, script: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}<body>${body}<script>
"use strict";
const $ = (id) => document.getElementById(id);
const say = (t) => { $("msg").textContent = t; };
async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}
async function assertion(optionsPath, extra) {
  const options = await post(optionsPath, extra);
  const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  return cred.toJSON();
}
${script}
</script>`;

export function setupPage(): string {
  return page(
    "Set up memory-anywhere",
    `<h1>Set up memory-anywhere</h1><p>Create the owner passkey for this server.</p>
<button id="go">Create passkey</button><p id="msg"></p>`,
    `const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
$("go").onclick = async () => {
  try {
    const options = await post("/setup/options", { token });
    const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
    await post("/setup/verify", { token, response: cred.toJSON() });
    location.href = "/admin";
  } catch (e) { say("Setup failed: " + e.message); }
};`,
  );
}

export function adminPage(): string {
  return page(
    "memory-anywhere admin",
    `<h1>Connect a new app</h1>
<div id="login"><button id="signin">Sign in with passkey</button></div>
<form id="open" hidden>
<label>App<select id="vendor"><option value="claude">Claude</option><option value="chatgpt">ChatGPT</option><option value="gemini">Gemini</option><option value="grok">Grok</option><option value="claude-code">Claude Code (direct)</option><option value="pc">PC (mema login)</option><option value="other">Other</option></select></label>
<label>Method<select id="method"><option value="static">Static client id and secret</option><option value="cimd">Client ID metadata document</option><option value="dcr">Dynamic registration</option></select></label>
<label>Redirect URI (only if the app's is not known yet)<input id="redirect" placeholder="https://…"></label>
<label>Redirect host (Other + dynamic registration)<input id="otherhost" placeholder="app.example.com"></label>
<label>Refresh tokens<select id="rotation"><option value="rotate">Rotate on every use</option><option value="fixed">Fixed (no rotation)</option></select></label>
<label><input type="checkbox" id="desktop" style="width:auto"> Desktop app on my computer (loopback redirect)</label>
<button>Open a 10-minute window</button></form>
<pre id="out" hidden></pre><p id="msg"></p>`,
    `$("signin").onclick = async () => {
  try { await post("/admin/api/login/verify", await assertion("/admin/api/login/options")); $("login").hidden = true; $("open").hidden = false; say(""); }
  catch (e) { say("Sign-in failed: " + e.message); }
};
$("open").onsubmit = async (ev) => {
  ev.preventDefault();
  const body = { vendor: $("vendor").value, method: $("method").value, redirectUri: $("redirect").value, otherHost: $("otherhost").value, rotation: $("rotation").value, desktop: $("desktop").checked };
  try {
    let w;
    try { w = await post("/admin/api/windows", body); }
    catch (e) {
      if (e.message !== "step_up_required") throw e;
      await post("/admin/api/stepup/verify", await assertion("/admin/api/stepup/options"));
      w = await post("/admin/api/windows", body);
    }
    await fetch(w.pair_link, { redirect: "manual" }); // binds this browser to the window (__Host-ma_pair)
    const lines = ["MCP URL: " + w.mcp_url, "Pair code: " + w.pair_code, "Window closes: " + new Date(w.expires_at).toLocaleTimeString()];
    if (w.credentials) lines.push("Client ID: " + w.credentials.client_id, "Client secret (shown once): " + w.credentials.client_secret, "Redirect: " + w.credentials.redirect_uris.join(" "));
    $("out").textContent = lines.join("\\n"); $("out").hidden = false; say("");
  } catch (e) { say("Could not open a window: " + e.message); }
};`,
  );
}

export interface ConsentView {
  uid: string;
  vendor: string;
  redirectUri: string;
  clientName: string | undefined;
  openedAt: number;
  now: number;
  scope: string;
  /** PC windows: the code `mema login` prints, so the owner can match them (§5.6). */
  pairCode: string | undefined;
  bound: boolean;
}

export function consentPage(v: ConsentView): string {
  const base = `/consent/${encodeURIComponent(v.uid)}`;
  if (!v.bound) {
    return page(
      "Enter the code",
      `<h1>Enter the code shown in your admin UI</h1><form id="f"><input id="code" autocomplete="off" autocapitalize="characters" maxlength="8"><button>Continue</button></form><p id="msg"></p>`,
      `$("f").onsubmit = async (ev) => { ev.preventDefault(); try { await post(${JSON.stringify(`${base}/code`)}, { code: $("code").value }); location.reload(); } catch { say("That code is not right."); } };`,
    );
  }
  const host = URL.parse(v.redirectUri)?.host ?? v.redirectUri;
  const minutes = Math.max(0, Math.round((v.now - v.openedAt) / 60_000));
  return page(
    "Approve connection",
    `<p>${esc(v.vendor)} wants to connect, returning to</p><p class="host">${esc(host)}</p>
<p class="muted">${esc(v.redirectUri)}</p>
${v.clientName ? `<p>Name: ${esc(v.clientName)} <span class="muted">(self-declared)</span></p>` : ""}
<p class="muted">Window opened ${minutes === 0 ? "less than a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`} ago.</p>
${v.pairCode ? `<p>Code: <b>${esc(v.pairCode)}</b>. It must match the code in your terminal.</p>` : ""}
<p>It will be able to <b>${esc(v.scope)}</b>.</p>
<h2>Did you just click Connect in ${esc(v.vendor)} yourself?</h2>
<button id="approve" disabled>Approve with passkey</button><button id="deny">Deny</button><p id="msg"></p>`,
    `setTimeout(() => { $("approve").disabled = false; }, 1000);
$("approve").onclick = async () => {
  try { const r = await post(${JSON.stringify(`${base}/approve`)}, await assertion(${JSON.stringify(`${base}/options`)})); location.href = r.redirectTo; }
  catch (e) { say("Not approved: " + e.message); }
};
$("deny").onclick = async () => { try { const r = await post(${JSON.stringify(`${base}/deny`)}); location.href = r.redirectTo; } catch (e) { say(e.message); } };`,
  );
}
