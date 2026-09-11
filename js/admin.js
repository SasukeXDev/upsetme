(function () {
  const U = OttfreeUtils;

  function showResult(id, ok, payload) {
    const box = document.getElementById(id);
    box.classList.toggle("is-error", !ok);
    box.classList.add("is-visible");
    box.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  }

  function wireTabs() {
    const tabs = document.querySelectorAll(".admin-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("is-active"));
        document.querySelector(`.admin-panel[data-panel="${tab.dataset.tab}"]`).classList.add("is-active");
      });
    });
  }

  // ---- Folders ----
  function wireFolders() {
    document.getElementById("form-create-folder").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { data, ok } = await OttfreeAPI.createFolder(f.get("folderName"), f.get("thumbnail"), f.get("parent_dir"));
      showResult("result-create-folder", ok, data || "Request failed.");
      if (ok) e.target.reset();
    });

    document.getElementById("form-search-folder").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { data, ok } = await OttfreeAPI.searchDbFolders(f.get("query"));
      const table = document.getElementById("folder-results");
      const tbody = table.querySelector("tbody");
      if (!ok || !Array.isArray(data) || !data.length) {
        table.style.display = "none";
        showResult("result-edit-folder", false, "No folders matched.");
        return;
      }
      table.style.display = "table";
      tbody.innerHTML = data
        .map(
          (row) => `
        <tr>
          <td>${U.escapeHtml(row.name)}</td>
          <td><code>${U.escapeHtml(row._id)}</code></td>
          <td style="display:flex; gap:8px;">
            <button class="btn btn--sm" data-edit="${U.escapeHtml(row._id)}" data-name="${U.escapeHtml(row.name)}">Edit</button>
            <button class="btn btn--sm btn--danger" data-delete="${U.escapeHtml(row._id)}">Delete</button>
          </td>
        </tr>`
        )
        .join("");

      tbody.querySelectorAll("[data-edit]").forEach((btn) =>
        btn.addEventListener("click", () => {
          const form = document.getElementById("form-edit-folder");
          form.style.display = "block";
          form.folder_id.value = btn.dataset.edit;
          form.folderName.value = btn.dataset.name;
          form.scrollIntoView({ behavior: "smooth", block: "center" });
        })
      );
      tbody.querySelectorAll("[data-delete]").forEach((btn) =>
        btn.addEventListener("click", async () => {
          if (!confirm("Delete this folder and everything inside it?")) return;
          const parent = prompt("Parent folder id (leave blank for root):", "") || "";
          const { data, ok } = await OttfreeAPI.deleteEntry(btn.dataset.delete, parent);
          showResult("result-edit-folder", ok, data || "Delete failed.");
          if (ok) btn.closest("tr").remove();
        })
      );
    });

    document.getElementById("form-edit-folder").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { data, ok } = await OttfreeAPI.editFolder(f.get("folder_id"), f.get("folderName"), f.get("thumbnail"), f.get("parent"));
      showResult("result-edit-folder", ok, data || "Update failed.");
    });
  }

  // ---- Files ----
  function wireFiles() {
    document.getElementById("form-edit-post").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { data, ok } = await OttfreeAPI.editPost(f.get("file_id"), f.get("fileName"), f.get("filethumbnail"), f.get("file_folder_id"));
      showResult("result-edit-post", ok, data || "Update failed.");
    });
  }

  // ---- Send to playlist ----
  function wireSend() {
    let loadedFiles = [];
    const picker = document.getElementById("send-picker");
    const submitBtn = document.getElementById("send-submit");

    document.getElementById("send-load-files").addEventListener("click", async () => {
      const chatId = document.getElementById("send-chat-id").value.trim();
      if (!chatId) return;
      picker.innerHTML = Array(6).fill(`<div class="skeleton" style="aspect-ratio:2/3"></div>`).join("");
      const { data, ok } = await OttfreeAPI.channel(chatId, 1);
      if (!ok || !data) {
        picker.innerHTML = "";
        showResult("result-send", false, "Couldn't load that channel.");
        return;
      }
      loadedFiles = data.files || [];
      if (!loadedFiles.length) {
        picker.innerHTML = "";
        showResult("result-send", false, "That channel has no files.");
        return;
      }
      picker.innerHTML = loadedFiles
        .map(
          (f, i) => `
        <label class="picker-item">
          <img src="${U.escapeHtml(U.resolveUrl(U.posterFor(f)))}" alt="" loading="lazy" />
          <input type="checkbox" data-i="${i}" />
          <span>${U.escapeHtml(U.displayTitle(f))}</span>
        </label>`
        )
        .join("");
      submitBtn.disabled = false;
    });

    submitBtn.addEventListener("click", async () => {
      const folderId = document.getElementById("send-folder-id").value.trim();
      const chatId = document.getElementById("send-chat-id").value.trim();
      const chosen = Array.from(picker.querySelectorAll("input:checked")).map((cb) => loadedFiles[Number(cb.dataset.i)]);
      if (!folderId || !chosen.length) {
        showResult("result-send", false, "Pick a destination folder and at least one file.");
        return;
      }
      const selectedIds = chosen
        .map((f) => [f.file_id ?? f.id, f.hash, U.displayTitle(f), f.file_size || f.size || "", f.file_type || f.mime_type || "", U.posterFor(f)].join("|"))
        .join(",");
      const { data, ok } = await OttfreeAPI.send(chatId, folderId, selectedIds);
      showResult("result-send", ok, data || "Send failed.");
    });
  }

  // ---- Cache ----
  function wireCache() {
    document.getElementById("reload-channel").addEventListener("click", async () => {
      const chatId = document.getElementById("reload-chat-id").value.trim();
      if (!chatId) { showResult("result-reload", false, "Enter a channel id first."); return; }
      const { data, ok } = await OttfreeAPI.reload(chatId);
      showResult("result-reload", ok, data || "Reload failed.");
    });
    document.getElementById("reload-home").addEventListener("click", async () => {
      if (!confirm("Clear every cached channel page?")) return;
      const { data, ok } = await OttfreeAPI.reload("home");
      showResult("result-reload", ok, data || "Reload failed.");
    });
  }

  // ---- Config ----
  function wireConfig() {
    document.getElementById("form-config").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const { data, ok } = await OttfreeAPI.config(f.get("channel"), f.get("theme"));
      showResult("result-config", ok, data || "Save failed.");
    });
  }

  // ---- local settings API (this server's own store — ads/notice/maintenance) ----
  async function localSettingsGet() {
    try {
      const res = await fetch("/local-api/settings");
      return res.ok ? await res.json() : null;
    } catch (e) {
      return null;
    }
  }

  async function localSettingsSave(section, data) {
    try {
      const res = await fetch("/local-api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Requested-With": "OttfreeAdmin" },
        body: JSON.stringify({ section, data }),
      });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, data: body };
    } catch (e) {
      return { ok: false, data: { error: "Request failed" } };
    }
  }

  function wireToggle(el) {
    el.addEventListener("click", () => {
      const on = el.classList.toggle("is-on");
      el.setAttribute("aria-checked", String(on));
    });
  }

  function isOn(el) { return el.classList.contains("is-on"); }
  function setOn(el, on) {
    el.classList.toggle("is-on", !!on);
    el.setAttribute("aria-checked", String(!!on));
  }

  // ---- Ads ----
  function wireAds() {
    const toggle = document.getElementById("ads-toggle");
    wireToggle(toggle);

    const picker = document.getElementById("ads-network-picker");
    picker.querySelectorAll("button").forEach((btn) =>
      btn.addEventListener("click", () => {
        picker.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
      })
    );

    document.getElementById("ads-save").addEventListener("click", async () => {
      const network = picker.querySelector(".is-active")?.dataset.network || "custom";
      const snippet = document.getElementById("ads-snippet").value;
      const { ok, data } = await localSettingsSave("ads", { enabled: isOn(toggle), network, snippet });
      showResult("result-ads", ok, data || "Save failed.");
    });

    document.getElementById("ads-preview-btn").addEventListener("click", () => {
      const snippet = document.getElementById("ads-snippet").value;
      const wrap = document.getElementById("ads-preview-wrap");
      const frame = document.getElementById("ads-preview-frame");
      wrap.style.display = "block";
      frame.srcdoc = `<!doctype html><html><head><style>body{margin:0;background:#0e1116;color:#8b93a0;font:13px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}</style></head><body><div id="ottfree-ad-test">${snippet || "Paste a snippet above, then click 'See test ad' again."}</div></body></html>`;
    });
  }

  // ---- Site (notice + maintenance) ----
  function wireSite() {
    const noticeToggle = document.getElementById("notice-toggle");
    wireToggle(noticeToggle);
    document.getElementById("notice-save").addEventListener("click", async () => {
      const { ok, data } = await localSettingsSave("notice", {
        enabled: isOn(noticeToggle),
        level: document.getElementById("notice-level").value,
        message: document.getElementById("notice-message").value,
      });
      showResult("result-notice", ok, data || "Save failed.");
    });

    const maintToggle = document.getElementById("maintenance-toggle");
    wireToggle(maintToggle);
    document.getElementById("maintenance-save").addEventListener("click", async () => {
      const { ok, data } = await localSettingsSave("maintenance", {
        enabled: isOn(maintToggle),
        message: document.getElementById("maintenance-message").value,
      });
      showResult("result-maintenance", ok, data || "Save failed.");
    });
  }

  async function loadExistingSettings() {
    const settings = await localSettingsGet();
    if (!settings) return;

    setOn(document.getElementById("ads-toggle"), settings.ads.enabled);
    document.getElementById("ads-snippet").value = settings.ads.snippet || "";
    const picker = document.getElementById("ads-network-picker");
    picker.querySelectorAll("button").forEach((b) => b.classList.toggle("is-active", b.dataset.network === settings.ads.network));

    setOn(document.getElementById("notice-toggle"), settings.notice.enabled);
    document.getElementById("notice-level").value = settings.notice.level || "info";
    document.getElementById("notice-message").value = settings.notice.message || "";

    setOn(document.getElementById("maintenance-toggle"), settings.maintenance.enabled);
    document.getElementById("maintenance-message").value = settings.maintenance.message || "";
  }

  async function checkAccess() {
    const gate = document.getElementById("access-gate");
    const body = document.getElementById("admin-body");
    const { data } = await OttfreeAPI.loginState();
    if (!data || !data.authenticated) {
      gate.innerHTML = `<div class="state-msg"><strong>Sign in required.</strong><a class="btn btn--primary" style="margin-top:12px" href="index.html?next=admin.html">Sign in</a></div>`;
      return;
    }
    // Probe an admin-only endpoint to confirm privileges, since login state alone doesn't re-assert is_admin.
    const probe = await OttfreeAPI.searchDbFolders("");
    if (probe.isAdminLockout) {
      gate.innerHTML = `<div class="state-msg"><strong>You're signed in, but this account isn't an admin.</strong>"Who the hell you are" — the backend's words, not ours.</div>`;
      return;
    }
    sessionStorage.setItem("ottfree:isAdmin", "1");
    body.style.display = "block";
    loadExistingSettings();
  }

  async function main() {
    U.initChrome({ ads: false });
    wireTabs();
    wireFolders();
    wireFiles();
    wireSend();
    wireCache();
    wireConfig();
    wireAds();
    wireSite();
    checkAccess();
  }

  main();
})();
