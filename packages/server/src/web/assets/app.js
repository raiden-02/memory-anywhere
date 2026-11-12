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
