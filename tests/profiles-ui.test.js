"use strict";

// Capa de perfiles (profile.js) en el popup real: selección inicial,
// persistencia en chrome.storage.local, cambio de perfil y carga de los
// scripts de cada perfil. Correr con: cd tests && npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { HEALTHY, CONFIGURED_URL, CONFIGURED_PAGE, openPopup } = require("./popup-harness");

// "Disco" de chrome.storage.local compartido entre aperturas del popup.
function disk(extra = {}) {
  return Object.assign({ generatedTextExpanded: true, someOtherSetting: "keep-me" }, extra);
}
const open = (local) => openPopup({ localStore: local, tabUrl: CONFIGURED_URL, pageHtml: CONFIGURED_PAGE(["A6DB4"]), csvRows: HEALTHY });
const scripts = (p) => Array.from(p.w.document.scripts, (s) => s.src.split("/").pop()).filter(Boolean);

test("primera ejecución sin perfil: selector, sin cargar la vista principal", async () => {
  const p = await open(disk());
  assert.equal(p.$("profileSelectView").hidden, false);
  assert.equal(p.$("appView").hidden, true);
  assert.equal(p.$("profileCancelBtn").hidden, true);
  assert.deepEqual(scripts(p), ["shared.js", "profile.js"]);
  p.close();
});

test("elegir CCT / CALL CENTER guarda el perfil; al reabrir entra directo con sus scripts", async () => {
  for (const [profile, extra] of [["cct", []], ["callcenter", ["callcenter.js", "cc-dashboard.js"]]]) {
    const local = disk();
    let p = await open(local);
    p.w.document.querySelector(`[data-profile="${profile}"]`).click();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(local.profile, profile);
    p.close();

    p = await open(local); // la recarga equivale a reabrir
    assert.equal(p.$("appView").hidden, false);
    assert.equal(p.$("profileSelectView").hidden, true);
    assert.equal(p.w.document.body.dataset.profile, profile);
    assert.deepEqual(scripts(p), ["shared.js", "profile.js", "popup.js", "dashboard.js", ...extra]);
    assert.deepEqual(p.errors, []);
    p.close();
  }
});

test("cambiar de perfil: selector con Cancelar; no toca otras claves de storage.local", async () => {
  const local = disk({ profile: "cct" });
  const p = await open(local);
  p.w.document.querySelector(".js-change-profile").click();
  assert.equal(p.$("profileSelectView").hidden, false);
  assert.equal(p.$("profileCancelBtn").hidden, false);
  p.$("profileCancelBtn").click();
  assert.equal(p.$("appView").hidden, false);
  assert.equal(local.profile, "cct");
  p.w.document.querySelector(".js-change-profile").click();
  p.w.document.querySelector('[data-profile="callcenter"]').click();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(local.profile, "callcenter");
  assert.equal(local.someOtherSetting, "keep-me");
  assert.equal(local.generatedTextExpanded, true);
  p.close();
});

test("valor de perfil inválido: vuelve a mostrar el selector", async () => {
  const p = await open(disk({ profile: "hacker" }));
  assert.equal(p.$("profileSelectView").hidden, false);
  assert.equal(p.$("appView").hidden, true);
  p.close();
});
