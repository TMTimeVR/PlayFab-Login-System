# Security review, September 2026

A full review of this login system and the five dependencies it pulls from GitHub.
Everything described under "Fixed" is already fixed in this repository. I have written
it up in the open because most of these bugs are ordinary, the kind anyone wiring
PlayFab to a Quest game will hit, and a worked example is more useful than a warning.

Scope: `main/LoginPF.cs`, `main/cloudscripts.js`, and the PlayFab Unity SDK, PhotonVR
(upstream and my fork), GCS-Wardrobe, EasyPlayfab and AdvancedPlayfab as dependencies.

| | Count |
|---|---|
| Fixed here | 21 |
| Outstanding in dependencies | 6 |
| Secrets found in any repository | 0 |

---

## The main problem

Two bugs combined to make the Oculus identity check decorative. Neither is clever.
Together they meant a modified client could ignore verification completely.

### The account to Oculus binding lived in storage the client could write

`main/cloudscripts.js`, handlers `VOI` and `verifyOculusIdMatches`.
`main/LoginPF.cs`, `announceloginwork`.

After login the client wrote its own Oculus ID into PlayFab **User Data**, and the
server read that value back to decide who the player was. User Data is writable by
any client through the `UpdateUserData` client API. The server was reading a value
the player controlled and treating it as identity.

`VOI` never wrote the binding either. It only ever compared the incoming claim
against whatever the client had stored, so the check compared the player's input to
the player's own earlier input.

The fix moves the binding to **User Internal Data**, which only the server can write.
`VOI` writes it, and only after Meta has validated the nonce. Binding is first
write wins, so a second Oculus account cannot claim an account that is already bound.
The client no longer writes it at all.

If you take one thing from this document, take this: PlayFab has three user data
stores and they are not interchangeable. User Data is client writable. Read Only
Data is server writable and client readable. Internal Data is server only. Anything
your server will later trust belongs in the last one.

### Verification ran on the server but was enforced by the client

`main/cloudscripts.js`, `GetPhotonAuth`. `main/LoginPF.cs`, `OIV`.

`VOI` returned `{valid: false}` and the client responded by quitting. Nothing changed
server side. PlayFab had already issued a session ticket before `VOI` ran, and every
other handler kept working regardless of the result. Deleting one line from a
decompiled build turned verification off.

Now `GetPhotonAuth` refuses to return the Photon AppIds unless the server has recorded
a successful verification for that account in the last 24 hours. Without the AppIds a
client cannot reach multiplayer. That decision happens on the server, so patching the
client does not help.

This is the general shape of the lesson. A client side check is a hint. If the
consequence of failing a check is code the client runs, the check does nothing. Make
the consequence something the server withholds.

---

## Also fixed

**Meta app secret in the URL query string.** Both `graph.oculus.com` calls sent
`access_token=OC|APP_ID|APP_SECRET` as a query parameter. Query strings turn up in
request logs at both ends, and any stack trace carrying the URL carries the secret.
Credentials now go in the POST body, through one helper, with PlayFab request logging
switched off for those calls.

**The most serious ban reason produced the weakest ban.** In `ReportPlayer`,
`"Exploiting"` mapped to `-1`, passed straight through as `DurationInHours`. A negative
duration is not a permanent ban, it is an invalid one. Every lesser reason produced a
real ban. Permanent reasons now omit `DurationInHours`, which is how `BanUsers`
expresses permanence.

**A JavaScript object used as a lookup table returned functions.** `ReasonDurations[Args.Reason]`
also resolves inherited `Object.prototype` members. A reason of `"constructor"` returns
a function, which is truthy, so it passed the `|| 24` fallback and reached `BanUsers` as
the duration. The SKU table in `GrantOculusCurrency` had the same shape. Both lookups now
use an own property check. This one surprised me. It is easy to write and invisible on
review.

**One webhook had no rate limit.** Every other webhook path was throttled. The spoofing
alert was not, and it fires on unauthenticated client input, so repeated bad nonces
flooded the channel and burned the title's API budget. Before the fix, 25 bad nonces
produced 25 posts. Now they produce one.

**`LoginPF.cs` did not compile in a player build.** Two hard errors, both outside
`#if UNITY_EDITOR`. `WebClient` was used without `using System.Net;`, and
`GameObject.active` has not existed since Unity 5.0. Worth stating plainly: if the file
does not build, none of the security work in it runs.

**A blocking network call on the VR main thread.** The version check ran
`WebClient().DownloadString` synchronously every twenty seconds, freezing rendering for
the whole round trip. On a slow connection that is long enough to trip the 25 second
watchdog that hard kills the process. It is a coroutine now, with a timeout.

**Ban polling switched itself off after one error.** `isChecking` was set before the
profile request and cleared only on success. The error path never reset it, and the
timeout coroutine written to catch that case was never started. One failed request
latched the flag for the rest of the session, so a player banned mid session was never
noticed by the client.

**Voice uploads decoded before checking their size.** The 8 MB cap applied to the decoded
buffer, so an oversized payload was fully in memory before anything rejected it. The
encoded string is bounded first now.

**Moderator actions accepted unvalidated targets.** `Args.TargetId` reached `BanUsers`
with no type check, the reason was unsanitised and unbounded, and nothing stopped a
moderator banning themselves or another moderator. Targets must now be non-empty
strings, reasons are sanitised, and the path is throttled.

**Handlers threw on absent arguments.** A CloudScript call with no `FunctionParameter`
threw on the first property access. Oculus responses went to `JSON.parse` unguarded, so
a 502 HTML page took the handler down. All 17 handlers now tolerate a null argument
object and Graph responses fail closed.

**The ban screen crashed instead of showing the ban.** `error.ErrorDetails` is null on
many `AccountBanned` responses and was iterated unguarded. Separately the sandbox check
compared `Scene.ToString()` against `"Sandbox"`, which never matches, because
`ToString()` does not return the scene name.

**Player usernames were reaching telemetry.** The PlayFab SDK attaches
`PersistentDataPath` and `DataPath` to login by default, and those paths contain the OS
account name. `DisableDeviceInfo` and `DisableFocusTimeCollection` are now set before
login.

**An archived script would have compiled into your game.** Dropping this repository into
`Assets/` compiled `SomeRandomPlayFabLoginScriptFrom2023.cs` as a second live
MonoBehaviour that logged players in from `Start()`, using `SystemInfo.deviceUniqueIdentifier`
as the only credential. It is behind a compile symbol now.

**Four features that looked like they worked and did not.** `CatalogName` was `readonly`,
which Unity does not serialize, so `[SerializeField]` did nothing and the special items
unlock never matched. The currency display wrote to a private field nothing assigned.
`GetWorkingOntext` called a coroutine without `StartCoroutine`. And `WardrobePurchase.cs`
contained a line of English prose, which is not valid C# and broke the build for anyone
importing the repository wholesale.

**Smaller robustness fixes.** `VirtualCurrency["MC"]` threw for any account that had
never held currency, meaning every new player. `HasMods` fired one ban request per
matching assembly. `BuyItem` passed a null error callback, so failures were silent.
Remote MOTD text had no length cap or timeout.

---

## What held up

**No secrets, anywhere.** I scanned working trees and full git history across all six
repositories for Photon AppIds, PlayFab title IDs, developer secret keys, Discord
webhooks and Meta app secrets. Nothing committed, and nothing committed then removed.
Keeping every secret in Internal Title Data was the right call and it held.

**No handler trusts a client supplied target.** Every `PlayFabId` in the CloudScript
resolves to `currentPlayerId` except two, and both are moderator gated. This matters
more than it sounds, for reasons in the next section.

**The PlayFab Unity SDK is current and unmodified.** Version `2.242.260805`, exactly at
upstream HEAD. No baked title ID or secret key, no server or admin API compiled into a
client build, no unsafe deserialization, no token logging, HTTPS throughout. No CVE
applies to the SDK itself.

**Purchases are validated server side.** Both the wardrobe path and the IAP path use
APIs that check price and entitlement on the server. A modified client cannot give
itself a discount.

---

## Outstanding, in dependencies

These live outside this repository, so they are not fixed here. I am describing the
shape of each problem and its fix rather than writing anything you could paste and run.

**PhotonVR trusts custom properties without checking them.** Photon custom properties
are written entirely by clients. `PhotonVRPlayer.cs` casts two of them with no type
check, inside a method that runs from `Awake()` on every player spawn. A malformed value
from one player throws on every other client in the room. Present in upstream
`fchb1239/PhotonVR` as well as my fork. The fix is `TryGetValue` plus a type check and a
try/catch with safe defaults.

**An RPC with no sender check.** `RPCRefreshPlayerValues` takes no `PhotonMessageInfo`,
so it cannot tell who called it, and PUN lets any client invoke an RPC on any PhotonView
it names. Combined with the item above, one player can make every client re-run the
failing code repeatedly. Each call also leaks a material instance. Add
`PhotonMessageInfo info`, reject when `info.Sender != photonView.Owner`, and rate limit.
Separately, turn on Photon's server side RPC allow list. It is not configured in any of
these repositories, which means every `[PunRPC]` in the project is callable by anyone in
the room.

**Three defects in my PhotonVR fork.** The duplicate manager guard is unreachable, because
two `else if` branches on a `bool` cover every case and the final `else` holding the
check never runs. `LogText` is `public static`, which Unity cannot serialize, so it is
null in every build and dereferenced in ten places. And the manager references a
cosmetics type that upstream deleted and the fork does not contain, so its write format
and `PhotonVRPlayer.cs`'s read format disagree.

**GCS-Wardrobe decides cosmetic ownership on the client.** Owned item lists gate only
what the local UI shows. Equipping writes a name string into Photon custom properties and
receiving clients activate whatever name arrives. No currency or inventory is granted, so
this is spoofing rather than theft, but if rare cosmetics are your reward loop it defeats
the point. The dependency cannot fix this alone. Validate the equipped ID against the
server side inventory before broadcasting it.

**EasyPlayfab has three CloudScript handlers that take a target from client arguments.**
`GrantItemToPlayer`, `GivePlayerCurrency` and `RemovePlayerCurrency` each read the target
PlayFabId, currency code and amount straight from `args`, with no authorization check and
no reference to `currentPlayerId`. `ExecuteCloudScript` is a client API. Any logged in
player can call these against any account. I am naming this because the code is public
and people copy it. This project does not use those handlers. If you borrowed from
EasyPlayfab, check.

**AdvancedPlayfab's README gives dangerous advice.** It tells developers any PlayFab API
may be used from the client, including Server and Admin. Doing that requires the title's
developer secret key in the shipped APK, which hands every player the ability to ban
anyone, grant anything and read all data. If you followed that advice, rotate the key.

---

## Deploying the changes

The CloudScript changes are not backward compatible in one direction. The Photon gate
denies sessions that have not been verified, so order matters.

1. Add `ALLOW_UNVERIFIED_PHOTON = "true"` to Internal Title Data **before** deploying the
   new revision. Unity Editor sessions have no real Oculus nonce, and this keeps them and
   any in flight old clients working while you test.
2. Deploy the new CloudScript revision and make it live.
3. Ship the updated `LoginPF.cs`. Existing players re-bind on their next login, because
   `VOI` adopts the Oculus ID it just validated. Nobody is locked out.
4. **Remove `ALLOW_UNVERIFIED_PHOTON`** once real headsets are verifying. Leaving it set
   disables the gate for everyone and undoes the main fix.
5. Watch the bans webhook for a day. Spoofing alerts are throttled to one per player per
   five minutes, so a burst now means something real.

---

## Still open by design

Login still uses `LoginWithCustomID` with the org scoped Oculus ID as the credential.
Anyone who learns another player's OUID can get a session for that account. The
verification gate limits what an unverified session can do, no Photon AppIds and no
entitlement grants, but it does not stop the ticket being issued.

Closing that properly means moving to a login method where Meta's proof mints the session
instead of being checked afterwards. That is a bigger change than a security pass should
make on its own, so it is still open. Worth planning if this stops being a hobby project.

---

## How this was checked

Findings were verified by running things, not by reading.

The CloudScript has 43 assertions against a mock PlayFab sandbox covering identity
binding, the Photon gate, the moderator paths, SKU handling and input validation. Run
against the pre-fix revision, 22 fail. Against the current one, all pass. The pre-fix run
prints the app secret sitting in a URL, hands Photon AppIds to an unverified session, and
shows `Exploiting` producing `-1`.

The tests are in this folder, so you can check the claims rather than take my word:

```
node reports/cloudscript-security-tests.js main/cloudscripts.js
```

Point it at an older revision of `cloudscripts.js` and you will see the original bugs
fail.

`LoginPF.cs` was compiled with Roslyn against stubs for the Unity, PlayFab, Photon and
Oculus APIs. The original produces the two errors described above. The current file
builds clean.

The secret scan covered working trees and full history in all six repositories.

Comments were stripped from the source with a character level scanner rather than a
regex, because both files contain URLs in string literals and a regex based strip treats
the `//` in `https://` as a comment and eats the rest of the line. All checks were re-run
afterwards.

---

Found something I missed? Contact details are in [SECURITY.md](../SECURITY.md).
