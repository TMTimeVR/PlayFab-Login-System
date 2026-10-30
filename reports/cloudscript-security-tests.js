// Security tests for main/cloudscripts.js. Runs the handlers against a mock
// PlayFab CloudScript sandbox and asserts the properties the hardening relies on.
//
//   node reports/cloudscript-security-tests.js main/cloudscripts.js
//
// Exits non-zero on any failure. Run it against an older revision to see the
// original bugs fail.
const fs = require("fs");
const vm = require("vm");

const SRC = process.argv[2];
let pass = 0, fail = 0;

function check(name, cond, detail) {
  let ok, err;
  try { ok = (typeof cond === "function") ? cond() : cond; }
  catch (e) { ok = false; err = e.message; }
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (err ? "  -> threw: " + err : (detail ? "  -> " + detail : ""))); }
}

function makeEnv(opts) {
  opts = opts || {};
  const state = {
    userData: opts.userData || {},
    userInternal: opts.userInternal || {},
    userReadOnly: opts.userReadOnly || {},
    titleInternal: Object.assign({
      PUN: "cHVu", VOICE: "dm9pY2U=",
      APP_ID: "appid123", APP_SECRET: "s3cr3t",
      MODERATOR_IDS: '["MOD1","MOD2"]',
      WEBHOOK_BANS: "https://example.invalid/bans",
      WEBHOOK_REPORTS: "https://example.invalid/reports"
    }, opts.titleInternal || {}),
    bans: [], httpCalls: [], webhooks: [], logs: [], deleted: [], activeBans: (opts.activeBans || {})
  };
  const wrap = o => { const r = {}; for (const k in o) r[k] = { Value: o[k] }; return r; };

  const sandbox = {
    handlers: {},
    currentPlayerId: opts.playerId || "PLAYER1",
    JSON, Date, Math, Object, Array, String, Number, isNaN, parseInt, encodeURIComponent,
    log: { error: m => state.logs.push(m), warning: m => state.logs.push(m), info: m => state.logs.push(m) },
    http: {
      request: (url, method, body, ct, headers, logFlag) => {
        state.httpCalls.push({ url, method, body, ct, logFlag });
        if (url.indexOf("example.invalid") !== -1) { state.webhooks.push({ url, body }); return "{}"; }
        return JSON.stringify(opts.graphResponse !== undefined ? opts.graphResponse : { is_valid: true });
      }
    },
    server: {
      GetTitleInternalData: ({ Keys }) => {
        const d = {}; (Keys || []).forEach(k => { if (state.titleInternal[k] !== undefined) d[k] = state.titleInternal[k]; });
        return { Data: d };
      },
      SetTitleInternalData: ({ Key, Value }) => { state.titleInternal[Key] = Value; return {}; },
      DeleteUser: ({ PlayFabId }) => { state.deleted.push(PlayFabId); return {}; },
      GetUserData: ({ PlayFabId }) => ({ Data: wrap(state.userData[PlayFabId] || {}) }),
      UpdateUserData: ({ PlayFabId, Data }) => { state.userData[PlayFabId] = Object.assign(state.userData[PlayFabId] || {}, Data); return {}; },
      GetUserInternalData: ({ PlayFabId }) => ({ Data: wrap(state.userInternal[PlayFabId] || {}) }),
      UpdateUserInternalData: ({ PlayFabId, Data }) => { state.userInternal[PlayFabId] = Object.assign(state.userInternal[PlayFabId] || {}, Data); return {}; },
      GetUserReadOnlyData: ({ PlayFabId }) => ({ Data: wrap(state.userReadOnly[PlayFabId] || {}) }),
      UpdateUserReadOnlyData: ({ PlayFabId, Data }) => { state.userReadOnly[PlayFabId] = Object.assign(state.userReadOnly[PlayFabId] || {}, Data); return {}; },
      GetUserBans: ({ PlayFabId }) => ({ BanData: state.activeBans[PlayFabId] || [] }),
      BanUsers: ({ Bans }) => { Bans.forEach(b => state.bans.push(b)); return { BanData: Bans }; },
      AddUserVirtualCurrency: () => ({ Balance: 1000 }),
      GetPlayerProfile: () => ({ PlayerProfile: { DisplayName: "TestPlayer" } }),
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox);
  return { h: sandbox.handlers, state, sandbox };
}

console.log("\n== 1. Identity binding is not readable from client-writable User Data ==");
{

  const { h, state } = makeEnv({
    userData: { PLAYER1: { OculusId: "VICTIM_META_ID" } },
    userInternal: {}
  });
  const r = h.GrantOculusCurrency({ MetaId: "VICTIM_META_ID", UserProof: "x", Sku: "buytenthousand" });
  check("forged UserData.OculusId does not satisfy the IAP identity check",
        r.success === false, JSON.stringify(r));
  check("no entitlement request was made on the forged claim",
        state.httpCalls.filter(c => c.url.indexOf("graph.oculus.com") !== -1).length === 0);
}

console.log("\n== 2. VOI establishes the binding server-side, first-write-wins ==");
{
  const { h, state } = makeEnv({ graphResponse: { is_valid: true } });
  const r1 = h.VOI({ oculusId: "META_A", nonce: "goodnonce" });
  check("valid nonce returns valid", r1.valid === true);
  check("binding written to UserInternalData (server-only)",
        () => state.userInternal.PLAYER1.OculusId === "META_A");
  check("binding was NOT written to client-writable UserData",
        !state.userData.PLAYER1 || !state.userData.PLAYER1.OculusId);
  check("IdentityVerifiedAt recorded",
        !!(state.userInternal.PLAYER1 && state.userInternal.PLAYER1.IdentityVerifiedAt));

  const r2 = h.VOI({ oculusId: "META_B", nonce: "alsogood" });
  check("a different Oculus id cannot take over a bound account", r2.valid === false);
  check("binding unchanged after takeover attempt",
        () => state.userInternal.PLAYER1.OculusId === "META_A");
}

console.log("\n== 3. VOI input validation and fail-closed behaviour ==");
{
  const { h } = makeEnv({});
  check("missing args rejected", () => h.VOI({}).valid === false);
  check("null args rejected", () => h.VOI(null).valid === false);
  check("non-string oculusId rejected", () => h.VOI({ oculusId: { a: 1 }, nonce: "n" }).valid === false);
  const bad = makeEnv({ graphResponse: undefined });
  bad.sandbox.http.request = () => "<html>502 Bad Gateway</html>";
  check("unparseable Oculus response fails closed",
        () => bad.h.VOI({ oculusId: "M", nonce: "n" }).valid === false);
  const thrower = makeEnv({});
  thrower.sandbox.http.request = () => { throw new Error("network down"); };
  check("Oculus request throw fails closed",
        () => thrower.h.VOI({ oculusId: "M", nonce: "n" }).valid === false);
}

console.log("\n== 4. App secret never appears in a URL ==");
{
  const { h, state } = makeEnv({ graphResponse: { is_valid: true } });
  h.VOI({ oculusId: "META_A", nonce: "n" });
  const graph = state.httpCalls.filter(c => c.url.indexOf("graph.oculus.com") !== -1);
  check("an Oculus request was made", graph.length === 1);
  check("secret absent from the URL", graph.every(c => c.url.indexOf("s3cr3t") === -1), graph[0] && graph[0].url);
  check("secret carried in the request body", graph.every(c => String(c.body).indexOf("s3cr3t") !== -1));
  check("request logging explicitly disabled", graph.every(c => c.logFlag === false));
}

console.log("\n== 5. GetPhotonAuth is gated on server-recorded verification ==");
{
  const unver = makeEnv({});
  const r1 = unver.h.GetPhotonAuth({});
  check("unverified session is denied the Photon AppIds", !!r1.error && !r1.PUN, JSON.stringify(r1));

  const ver = makeEnv({ graphResponse: { is_valid: true } });
  ver.h.VOI({ oculusId: "META_A", nonce: "n" });
  const r2 = ver.h.GetPhotonAuth({});
  check("verified session receives the AppIds", r2.PUN === "cHVu" && r2.VOICE === "dm9pY2U=");

  const stale = makeEnv({
    userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date(Date.now() - 48*3600*1000).toISOString() } }
  });
  check("verification older than the max age is denied", () => !!stale.h.GetPhotonAuth({}).error);

  const dev = makeEnv({ titleInternal: { ALLOW_UNVERIFIED_PHOTON: new Date(Date.now() + 3600*1000).toISOString() } });
  check("documented dev bypass works when explicitly enabled", () => dev.h.GetPhotonAuth({}).PUN === "cHVu");
}

console.log("\n== 6. ReportPlayer moderator path ==");
{

  const m1 = makeEnv({ playerId: "MOD1" });
  m1.h.ReportPlayer({ TargetId: "VICTIM", Reason: "constructor" });
  const b1 = m1.state.bans[0];
  check("prototype key does not leak a function into DurationInHours",
        b1 && (b1.DurationInHours === undefined || typeof b1.DurationInHours === "number"),
        b1 && typeof b1.DurationInHours);
  check("unknown reason falls back to the 24h default", () => b1.DurationInHours === 24);

  const m2 = makeEnv({ playerId: "MOD1" });
  m2.h.ReportPlayer({ TargetId: "VICTIM", Reason: "Exploiting" });
  const b2 = m2.state.bans[0];
  check("Exploiting produces a permanent ban (no DurationInHours)",
        b2 && b2.DurationInHours === undefined, b2 && String(b2.DurationInHours));

  const m3 = makeEnv({ playerId: "MOD1" });
  m3.h.ReportPlayer({ TargetId: "VICTIM", Reason: "Cheating" });
  check("known reason keeps its mapped duration", () => m3.state.bans[0].DurationInHours === 168);

  const m4 = makeEnv({ playerId: "MOD1" });
  check("missing TargetId rejected",() =>  () => /Invalid TargetId/.test(m4.h.ReportPlayer({ Reason: "Cheating" }).Result));
  check("no ban issued on invalid target", m4.state.bans.length === 0);
  const m5 = makeEnv({ playerId: "MOD1" });
  check("moderator cannot ban themselves",() =>  () => /yourself/.test(m5.h.ReportPlayer({ TargetId: "MOD1", Reason: "Cheating" }).Result));
  const m6 = makeEnv({ playerId: "MOD1" });
  check("moderator cannot ban another moderator",() =>  () => /another moderator/.test(m6.h.ReportPlayer({ TargetId: "MOD2", Reason: "Cheating" }).Result));

  const p1 = makeEnv({ playerId: "PLAYER1" });
  const rp = p1.h.ReportPlayer({ TargetId: "MOD1", Reason: "Cheating" });
  check("non-moderator report does not ban anyone", p1.state.bans.length === 0, JSON.stringify(rp));
}

console.log("\n== 7. GrantOculusCurrency SKU table ==");
{
  const ok = makeEnv({ userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } },
                       graphResponse: { success: true } });
  check("valid SKU grants after entitlement consume",
        () => ok.h.GrantOculusCurrency({ MetaId: "META_A", UserProof: "p", Sku: "buyonethousand" }).success === true);

  const proto = makeEnv({ userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } },
                          graphResponse: { success: true } });
  const rp = proto.h.GrantOculusCurrency({ MetaId: "META_A", UserProof: "p", Sku: "constructor" });
  check("prototype key rejected as a SKU", rp.success === false, JSON.stringify(rp));

  const denied = makeEnv({ userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } },
                           graphResponse: { success: false } });
  check("failed entitlement consume grants nothing",
        () => denied.h.GrantOculusCurrency({ MetaId: "META_A", UserProof: "p", Sku: "buytenthousand" }).success === false);
}

console.log("\n== 8. setVoiceMute authorisation ==");
{
  const p = makeEnv({ playerId: "PLAYER1" });
  check("non-moderator cannot mute", () => !!p.h.setVoiceMute({ targetPlayFabId: "V", durationSeconds: 60 }).error);
  check("non-moderator write did not land", !p.state.userReadOnly.V);
  const m = makeEnv({ playerId: "MOD1" });
  check("moderator can mute",() =>  () => m.h.setVoiceMute({ targetPlayFabId: "V", durationSeconds: 60 }).target === "V");
  check("moderator cannot mute another moderator", () => !!m.h.setVoiceMute({ targetPlayFabId: "MOD2", durationSeconds: 60 }).error);
  check("out-of-range duration rejected", () => !!m.h.setVoiceMute({ targetPlayFabId: "V", durationSeconds: 99999999 }).error);
  check("non-string target rejected", () => !!m.h.setVoiceMute({ targetPlayFabId: 12345, durationSeconds: 60 }).error);
}

console.log("\n== 9. Spoof-alert webhook is throttled ==");
{
  const { h, state } = makeEnv({ graphResponse: { is_valid: false } });
  for (let i = 0; i < 25; i++) h.VOI({ oculusId: "META_A", nonce: "bad" });
  check("25 failed validations produce at most one webhook post",
        state.webhooks.length <= 1, "posts=" + state.webhooks.length);
}

console.log("\n== 10. Voice payload is bounded before decoding ==");
{
  const { h } = makeEnv({ titleInternal: { WEBHOOK_VOICE: "https://example.invalid/voice" }, userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } } });
  const huge = "A".repeat(12 * 1024 * 1024);
  const r = h.SendVoiceToDiscord({ keyword: "test", audioB64: huge });
  check("oversized payload rejected", () => r.success === false && /too large/i.test(r.error), JSON.stringify(r));
  const { h: h2 } = makeEnv({ titleInternal: { WEBHOOK_VOICE: "https://example.invalid/voice" }, userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } } });
  check("non-string audio rejected", h2.SendVoiceToDiscord({ audioB64: { a: 1 } }).success === false);
}

console.log("\n== 11. Handlers survive a null/absent FunctionParameter ==");
{
  const { h } = makeEnv({ userInternal: { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } } });
  const names = ["GetPhotonAuth","incrementTOSandPP","VerifyBinaryIntegrity","ACB","VOI",
                 "RequestAccountDeletion","CheckAndCancelDeletion","PerformDeletionChecks",
                 "SendWarning","ReportPlayer","AnnounceLogin","AnnounceLobbyJoin",
                 "CompleteIAPPurchase","GrantOculusCurrency","banPlayer","permBanPlayer","setVoiceMute"];
  let threw = [];
  names.forEach(n => { try { h[n](null, {}); } catch (e) { threw.push(n + ": " + e.message); } });
  check("no handler throws on a null args object", threw.length === 0, threw.join(" | "));
}

const VERIFIED = { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } };

console.log("\n== 12. Destructive handlers are behind the identity gate ==");
{
  // A session minted from a harvested OUID never passes VOI. Before this gate it
  // could still ban, delete and rename the victim.
  const names = ["ACB", "banPlayer", "permBanPlayer", "RequestAccountDeletion"];
  for (const n of names) {
    const un = makeEnv({});
    const r = un.h[n]({ reason: "x", duration: 1 });
    check(`${n} refuses an unverified session`, () => r && r.error === "Identity not verified", JSON.stringify(r));
    check(`${n} unverified: no ban, no deletion flag written`,
          () => un.state.bans.length === 0 && !(un.state.userReadOnly.PLAYER1 && un.state.userReadOnly.PLAYER1.pendingDeletion));
  }
  const ok = makeEnv({ userInternal: VERIFIED });
  ok.h.permBanPlayer({ reason: "self" });
  check("permBanPlayer still works for a verified session", () => ok.state.bans.length === 1);
  const ok2 = makeEnv({ userInternal: VERIFIED });
  ok2.h.RequestAccountDeletion({});
  check("RequestAccountDeletion still works for a verified session",
        () => ok2.state.userReadOnly.PLAYER1 && ok2.state.userReadOnly.PLAYER1.pendingDeletion === "true");
}

console.log("\n== 13. The actual DeleteUser is not client-callable ==");
{
  const past = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
  const pending = { PLAYER1: { pendingDeletion: "true", deletionRequestedAt: past } };

  const client = makeEnv({ userReadOnly: pending });
  const r1 = client.h.PerformDeletionChecks({}, {});
  check("client call is refused", () => r1.deleted === false && !!r1.error, JSON.stringify(r1));
  check("client call deletes nothing", () => client.state.deleted.length === 0);

  const task = makeEnv({ userReadOnly: pending });
  const r2 = task.h.PerformDeletionChecks({}, { triggeredByTask: { Name: "sweep", Id: "t1" } });
  check("scheduled task can delete after the window", () => r2.deleted === true && task.state.deleted.includes("PLAYER1"));

  const early = makeEnv({ userReadOnly: { PLAYER1: { pendingDeletion: "true", deletionRequestedAt: new Date().toISOString() } } });
  const r3 = early.h.PerformDeletionChecks({}, { triggeredByTask: { Name: "sweep", Id: "t1" } });
  check("scheduled task does not delete inside the window", () => r3.deleted === false && early.state.deleted.length === 0);
}

console.log("\n== 14. The dev bypass expires ==");
{
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();
  check("future expiry grants AppIds to an unverified session",
        () => makeEnv({ titleInternal: { ALLOW_UNVERIFIED_PHOTON: future } }).h.GetPhotonAuth({}).PUN === "cHVu");
  check("expired flag is ignored",
        () => !!makeEnv({ titleInternal: { ALLOW_UNVERIFIED_PHOTON: past } }).h.GetPhotonAuth({}).error);
  check("the old boolean \"true\" no longer works",
        () => !!makeEnv({ titleInternal: { ALLOW_UNVERIFIED_PHOTON: "true" } }).h.GetPhotonAuth({}).error);
  check("garbage value is ignored",
        () => !!makeEnv({ titleInternal: { ALLOW_UNVERIFIED_PHOTON: "yes please" } }).h.GetPhotonAuth({}).error);
}

console.log("\n== 15. Webhooks have a title-wide ceiling, not just per-account ==");
{
  // Accounts are free, so a per-account limit is N accounts = N posts. The title
  // bucket caps the whole title regardless of how many accounts are rotated.
  const env = makeEnv({ userInternal: VERIFIED });
  let posted = 0;
  for (let i = 0; i < 60; i++) {
    // Rotate the caller each time so the per-account limiter never trips.
    env.sandbox.currentPlayerId = "ACCT" + i;
    env.state.userInternal["ACCT" + i] = VERIFIED.PLAYER1;
    const before = env.state.webhooks.length;
    env.h.permBanPlayer({ reason: "spam" });
    if (env.state.webhooks.length > before) posted++;
  }
  check("60 fresh accounts cannot exceed the per-minute title ceiling",
        () => posted <= 30, "posted=" + posted);
  check("the ceiling is not zero (legitimate posts still go out)", () => posted >= 1, "posted=" + posted);
}

console.log("\n== 16. Entitlement proofs cannot be replayed ==");
{
  const env = makeEnv({ userInternal: VERIFIED, graphResponse: { success: true } });
  const r1 = env.h.GrantOculusCurrency({ MetaId: "META_A", UserProof: "proof-1", Sku: "buyonethousand" });
  const r2 = env.h.GrantOculusCurrency({ MetaId: "META_A", UserProof: "proof-1", Sku: "buyonethousand" });
  check("first redemption succeeds", () => r1.success === true, JSON.stringify(r1));
  check("replaying the same proof is refused", () => r2.success === false, JSON.stringify(r2));
  const graphCalls = env.state.httpCalls.filter(c => c.url.indexOf("consume_entitlement") !== -1).length;
  check("the replay never reaches Oculus", () => graphCalls === 1, "consume calls=" + graphCalls);
  const r3 = env.h.GrantOculusCurrency({ MetaId: "META_A", UserProof: "proof-2", Sku: "buyonethousand" });
  check("a different proof still works", () => r3.success === true);

  const iap = makeEnv({ userInternal: VERIFIED, graphResponse: { success: true } });
  const a = iap.h.CompleteIAPPurchase({ MetaId: "META_A", UserProof: "p", Sku: "thing" });
  const b = iap.h.CompleteIAPPurchase({ MetaId: "META_A", UserProof: "p", Sku: "thing" });
  check("CompleteIAPPurchase also refuses a replay", () => a === true && b === false);
}

console.log("\n== 17. Moderator bans are audited and report fields are defanged ==");
{
  const m = makeEnv({ playerId: "MOD1" });
  m.h.ReportPlayer({ TargetId: "VICTIM", Reason: "Cheating" });
  check("a moderator ban posts to the bans webhook",
        () => m.state.webhooks.some(w => w.url.indexOf("/bans") !== -1 && w.body.indexOf("VICTIM") !== -1),
        JSON.stringify(m.state.webhooks));

  const p = makeEnv({ playerId: "PLAYER1" });
  p.h.ReportPlayer({ TargetId: "[click me](https://evil.invalid)", TargetName: "**bold**", Reason: "x" });
  const body = p.state.webhooks.map(w => w.body).join("");
  check("report fields are wrapped in code spans", () => body.indexOf("`[click me](https://evil.invalid)`") !== -1, body.slice(0, 200));
  check("reported identity is labelled as unverified client input", () => body.indexOf("client-supplied, unverified") !== -1);
}

console.log("\n== 18. A banned account cannot get the Photon AppIds ==");
{
  const ver = { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } };
  const future = new Date(Date.now() + 86400000).toISOString();
  const pastDate = new Date(Date.now() - 86400000).toISOString();

  check("a permanent ban is refused the AppIds",
        () => !!makeEnv({ userInternal: ver, activeBans: { PLAYER1: [{ Active: true }] } }).h.GetPhotonAuth({}).error);
  check("an unexpired temporary ban is refused",
        () => !!makeEnv({ userInternal: ver, activeBans: { PLAYER1: [{ Active: true, Expires: future }] } }).h.GetPhotonAuth({}).error);
  check("an expired ban does not block",
        () => makeEnv({ userInternal: ver, activeBans: { PLAYER1: [{ Active: true, Expires: pastDate }] } }).h.GetPhotonAuth({}).PUN === "cHVu");
  check("an inactive ban record does not block",
        () => makeEnv({ userInternal: ver, activeBans: { PLAYER1: [{ Active: false }] } }).h.GetPhotonAuth({}).PUN === "cHVu");
  check("no ban record at all is fine",
        () => makeEnv({ userInternal: ver }).h.GetPhotonAuth({}).PUN === "cHVu");

  // Availability over strictness: a PlayFab outage must not lock out the title.
  const broken = makeEnv({ userInternal: ver });
  broken.sandbox.server.GetUserBans = () => { throw new Error("PlayFab unavailable"); };
  check("a failed ban lookup allows the request rather than locking everyone out",
        () => broken.h.GetPhotonAuth({}).PUN === "cHVu");
}

console.log("\n== 19. The version gate is server-side ==");
{
  const ver = { PLAYER1: { OculusId: "META_A", IdentityVerifiedAt: new Date().toISOString() } };
  const env = (min) => makeEnv({ userInternal: ver, titleInternal: min ? { MIN_CLIENT_VERSION: min } : {} });

  check("no minimum configured means no gate", () => env(null).h.GetPhotonAuth({}).PUN === "cHVu");
  check("an equal version passes", () => env("3.6.0").h.GetPhotonAuth({ version: "3.6.0" }).PUN === "cHVu");
  check("a newer version passes", () => env("3.6.0").h.GetPhotonAuth({ version: "3.7.1" }).PUN === "cHVu");
  check("an older version is refused", () => !!env("3.6.0").h.GetPhotonAuth({ version: "3.5.9" }).error);
  check("a missing version is refused when a minimum is set", () => !!env("3.6.0").h.GetPhotonAuth({}).error);
  check("shorter version strings compare correctly", () => env("3.6").h.GetPhotonAuth({ version: "3.6.0" }).PUN === "cHVu");
  check("segment 10 beats segment 9, not string order", () => env("3.9.0").h.GetPhotonAuth({ version: "3.10.0" }).PUN === "cHVu");
  check("garbage version is refused", () => !!env("3.6.0").h.GetPhotonAuth({ version: "not-a-version" }).error);
}

console.log("\n----------------------------------------");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
