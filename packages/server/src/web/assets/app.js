// The one first-party script of the server's pages (auth-and-security.md §8). Each page names its
// behaviour in <body data-page>, and its CSRF token in data-csrf. No HTML is ever built from
// strings here: text goes in through textContent, which also satisfies Trusted Types.

const body = document.body;
const csrf = body.dataset.csrf ?? "";
const base = body.dataset.base ?? "";
const $ = (id) => document.getElementById(id);
const say = (text) => {
  const el = $("msg");
  if (el) el.textContent = text;
};

async function post(path, payload) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ma-csrf": csrf },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

/** A user-verified assertion over a challenge the server issued at `optionsPath`. */
async function assertion(optionsPath, extra) {
  const options = await post(optionsPath, extra);
  const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
  return credential.toJSON();
}

/** A new passkey over a challenge the server issued at `optionsPath`. */
async function registration(optionsPath, extra) {
  const options = await post(optionsPath, extra);
  const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
  return credential.toJSON();
}

/** A form's fields as JSON: data-type="bool" and "datetime" turn into booleans and ISO times. */
function fieldsOf(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    const type = el.dataset.type;
    if (type === "bool") out[el.name] = el.type === "checkbox" ? el.checked : el.value === "true";
    else if (type === "datetime") out[el.name] = el.value ? new Date(el.value).toISOString() : "";
    else if (el.value !== "") out[el.name] = el.value;
  }
  return out;
}

/** Runs a request; if the server wants a fresh passkey (§3.4), asks for it once and retries. */
async function withStepUp(request) {
  try {
    return await request();
  } catch (e) {
    if (e.message !== "step_up_required") throw e;
    await post("/api/stepup/verify", await assertion("/api/stepup/options"));
    return request();
  }
}

const pages = {
  "consent-code": () => {
    $("code-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await post(`${base}/code`, { code: $("code").value });
        location.reload();
      } catch {
        say("That code is not right.");
      }
    });
  },
  consent: () => {
    const approve = $("approve");
    // A second of delay, so a click meant for the app's own button cannot land on Approve.
    setTimeout(() => { approve.disabled = false; }, 1000);
    approve.addEventListener("click", async () => {
      try {
        const r = await post(`${base}/approve`, await assertion(`${base}/options`));
        location.assign(r.redirectTo);
      } catch (e) {
        say(`Not approved: ${e.message}`);
      }
    });
    $("deny").addEventListener("click", async () => {
      try {
        const r = await post(`${base}/deny`);
        location.assign(r.redirectTo);
      } catch (e) {
        say(e.message);
      }
    });
  },
  setup: () => {
    // The token arrives in the fragment (never sent to the server in a URL), then leaves the address bar.
    const token = location.hash.slice(1);
    history.replaceState(null, "", location.pathname);
    const show = (n) => {
      for (const i of [1, 2, 3]) $(`step-${i}`).hidden = i !== n;
    };
    const add = async (extra) => {
      const response = await registration("/setup/options", { token });
      return post("/setup/verify", { token, response, ...extra });
    };
    $("add-1").addEventListener("click", async () => {
      try {
        await add({ label: "First passkey" });
        show(2);
        say("");
      } catch (e) {
        say(`Not added: ${e.message}`);
      }
    });
    $("add-2").addEventListener("click", async () => {
      try {
        const r = await add({ label: "Second passkey", differentProviders: $("different").checked });
        const list = $("codes");
        for (const code of r.codes) {
          const li = document.createElement("li");
          li.textContent = code;
          list.append(li);
        }
        show(3);
        say("");
      } catch (e) {
        say(e.message === "same_provider" ? "This looks like the same provider as the first passkey. Use another one, or tick the box if they really differ." : `Not added: ${e.message}`);
      }
    });
    $("confirm").addEventListener("click", async () => {
      try {
        await post("/setup/confirm", { token, code: $("confirm-code").value });
        location.assign("/");
      } catch {
        say("That is not one of the codes.");
      }
    });
  },
  signin: () => {
    $("signin").addEventListener("click", async () => {
      try {
        await post("/api/login/verify", await assertion("/api/login/options"));
        location.reload();
      } catch (e) {
        say(`Not signed in: ${e.message}`);
      }
    });
  },
  approve: () => {
    const approve = $("approve");
    if (!approve) return;
    setTimeout(() => { approve.disabled = false; }, 1000);
    const once = async (confirm) => {
      const response = await assertion(`${base}/options`);
      return post(`${base}/approve`, { response, confirm });
    };
    approve.addEventListener("click", async () => {
      try {
        let r = await once($("confirm")?.value);
        // An export to an unregistered key needs a second, separate passkey approval.
        if (r.result === "second") {
          say("Approve once more to confirm the unregistered key.");
          r = await once();
        }
        say("Approved. You can close this page; the command continues in your terminal.");
        approve.disabled = true;
      } catch (e) {
        say(e.message === "wrong_suffix" ? "Those are not the key's last 8 characters." : `Not approved: ${e.message}`);
      }
    });
    $("deny").addEventListener("click", async () => {
      try {
        await post(`${base}/deny`);
        say("Denied.");
        approve.disabled = true;
      } catch (e) {
        say(e.message);
      }
    });
  },
  admin: () => {
    // Every <form class="act" data-action="…"> runs one owner action; actions that need a fresh
    // passkey (§3.4) answer step_up_required, and the page asks for it once, then retries.
    for (const form of document.querySelectorAll("form.act")) {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) return;
        try {
          const r = await withStepUp(() => post(`/api/act/${form.dataset.action}`, { input: fieldsOf(form) }));
          if (r.result && typeof r.result === "object" && "forgotten" in r.result) say(`Reverted: ${r.result.forgotten} forgotten, ${r.result.restored} restored, ${r.result.observations} observations closed.`);
          else location.reload();
        } catch (e) {
          say(e.message);
        }
      });
    }
    const pair = $("pair-form");
    pair?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const w = await withStepUp(() => post("/api/windows", fieldsOf(pair)));
        const out = $("pair-result");
        out.replaceChildren();
        const row = (label, value) => {
          const dt = document.createElement("dt");
          dt.textContent = label;
          const dd = document.createElement("dd");
          dd.textContent = value;
          out.append(dt, dd);
        };
        row("Server URL", w.mcp_url);
        row("Pairing code", w.pair_code);
        row("Open this link in this browser first", w.pair_link);
        if (w.credentials) {
          row("Client ID", w.credentials.client_id);
          row("Client secret (shown once)", w.credentials.client_secret);
        }
        row("Closes", new Date(w.expires_at).toLocaleTimeString());
        out.hidden = false;
        say("");
      } catch (e) {
        say(e.message === "replace_required" ? "This app is already connected: tick Replace to connect it again." : e.message);
      }
    });
    $("cancel-reset")?.addEventListener("click", async () => {
      try {
        await withStepUp(() => post("/api/reset/cancel"));
        location.reload();
      } catch (e) {
        say(e.message);
      }
    });
  },
  recover: () => {
    $("recover-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const r = await post("/recover", { code: $("code").value });
        location.assign(r.enroll);
        location.reload();
      } catch {
        say("That code did not work.");
      }
    });
  },
};

export { assertion, post, registration, say };

pages[body.dataset.page]?.();
