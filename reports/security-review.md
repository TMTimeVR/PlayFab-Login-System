# Security review, September 2026

A full review of this login system and the five dependencies it pulls from GitHub.
Everything described under "Fixed" is already fixed in this repository. I have written
it up in the open because most of these bugs are ordinary, the kind anyone wiring
PlayFab to a Quest game will hit, and a worked example is more useful than a warning.

Scope: `main/LoginPF.cs`, `main/cloudscripts.js`, and the PlayFab Unity SDK, PhotonVR
(upstream and my fork), GCS-Wardrobe, EasyPlayfab and AdvancedPlayfab as dependencies.

| | Count |
|---|---|
| Fixed here | 21, plus 8 across two later passes |
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

1. Set `ALLOW_UNVERIFIED_PHOTON` in Internal Title Data to an expiry timestamp a few
   days out, for example `2026-10-01T00:00:00Z`, **before** deploying the new revision.
   Unity Editor sessions have no real Oculus nonce, and this keeps them and any in
   flight old clients working while you test. It is a timestamp, not `"true"`; the
   boolean form was retired in the second pass because it was too easy to leave on.
2. Deploy the new CloudScript revision and make it live.
3. Create the scheduled task for `PerformDeletionChecks` (see the README). Without it,
   account deletion requests are recorded but never carried out.
4. Ship the updated `LoginPF.cs`. Existing players re-bind on their next login, because
   `VOI` adopts the Oculus ID it just validated. Nobody is locked out.
5. Let `ALLOW_UNVERIFIED_PHOTON` expire once real headsets are verifying, or remove it.
   Every use while it is active is logged as a warning, so a busy log after the rollout
   means it is still doing work it should not be.
6. Watch the bans webhook for a day. Spoofing alerts are throttled to one per player per
   five minutes and every webhook to thirty a minute title-wide, so a burst now means
   something real.

---

## Second pass, after an external audit

A second audit, done separately and grounded in twelve real Frida mod menus for this
family of games, went through this repository after the review above. It found one
thing I had got badly wrong, and I want to be plain about it.

The section that used to be here said the verification gate "limits what an
unverified session can do, no Photon AppIds and no entitlement grants." That was
true and it was the wrong thing to say, because it left out what an unverified session
*could* still do. The gate covered the handlers that give things. It did not cover
the ones that take them away. A session minted from a harvested Oculus ID could not
verify as the victim, but it could call `permBanPlayer`, `banPlayer`, `ACB` and
`RequestAccountDeletion`, all of which act on `currentPlayerId`, which was now the
victim. So a leaked ID was not "a session for that account." It was the victim banned
and, after 48 hours, deleted. I gated the wrong half.

What that pass fixed:

**The destructive handlers are gated.** `ACB`, `banPlayer`, `permBanPlayer`,
`RequestAccountDeletion` and `SendVoiceToDiscord` now refuse a session that has not
passed `VOI`. Same helper, same check, same reason the Photon gate works: the
consequence lives on the server.

**`DeleteUser` is no longer client-callable.** `PerformDeletionChecks` refuses to run
unless `context.triggeredByTask` is set, which only a PlayFab scheduled task provides.
Before, the actual deletion was one client call away from anyone holding the ticket.
It now needs a scheduled task to exist at all, which the README explains.

**The dev bypass expires.** `ALLOW_UNVERIFIED_PHOTON` was a boolean that was easy to
leave on, and while it was on the gate was off for everyone. It is now an ISO
timestamp; the flag is honoured only while that time is in the future, and every use
is logged. The old `"true"` does nothing.

**Webhooks have a title-wide ceiling.** Every rate limit was per account, and accounts
are free to make. One account, one post; N accounts, N posts; every post billed
against the CloudScript HTTP budget. A title-global bucket in Internal Title Data now
caps each webhook at thirty posts a minute regardless of how many accounts are
rotated through it.

**Entitlement proofs cannot be replayed.** The IAP handlers trusted Oculus's consume
call to be strictly one-shot and kept no record of their own. They now store the last
fifty consumed proofs per player in Internal Data and refuse a repeat before it ever
reaches Oculus.

**A banned account cannot get the Photon AppIds, and nor can an out-of-date client.**
A third report, this one a static teardown of a shipped APK, pointed out that ban
enforcement was "enable and disable objects on the banned client", which a modded
client ignores. The ban state came from PlayFab, so the source of truth was right and
only the enforcement was in the wrong place. `GetPhotonAuth` now checks
`server.GetUserBans` and a `MIN_CLIENT_VERSION` from title data before returning
anything. Two limits worth stating: it bites on the next connect, so a player banned
mid-session plays on until they reconnect, and the version comes from the client so a
modded build can lie about it. The ban lookup fails open on a PlayFab error, because
locking out the whole title during an outage is worse than one banned player
reconnecting.

**Moderator bans are audited, and reports are defanged.** A moderator ban posted
nothing to the bans webhook, so a compromised moderator account was game-wide ban
capability with no forensic trail. It posts actor, target and reason now. Report
fields are wrapped in code spans so a forged report cannot carry masked links, and the
reported identity is labelled as client-supplied so a moderator does not mistake it
for a verified one.

---

## Still open

Everything under [What is still open](../README.md#what-is-still-open) in the README,
which is the honest list. The ones that matter most:

**A leaked Oculus ID still yields a session.** The gate now stops that session doing
anything destructive, reaching multiplayer, or spending. It cannot stop the ticket
being issued. The fix is minting the PlayFab session from Meta's proof rather than
checking it afterward, which is an architecture change and has not been made.

**One headset, unlimited accounts.** The binding stops a second Oculus user claiming
an account. It does not stop one Oculus user making many. A banned player creates a
fresh account, verifies it with the same real headset, and is back in. Until the
binding is bidirectional, a ban is friction. That needs a reverse index the current
CloudScript does not have a clean primitive for, so it is a design decision rather
than a patch.

**Client-side anti-cheat is telemetry.** `HasMods`, `VerifyBinaryIntegrity` and the
signature check all run on the client, and the mod menus inject natively after login,
so none of them see anything. Treat them as signals. The signature check ships
disabled.

**Mid-session enforcement is client-side.** A banned player is only removed from a
room because their own client polls for the ban and disconnects. A modded client does
not. That needs a Photon webhook.

**The Photon UserId is the PlayFab ID**, which is stable, which makes every player
trackable through Photon's `FindFriends`. The fix belongs in `LoginPF.cs` where the
Photon auth parameters are set, and it interacts with everything that needs a stable
Photon identity, so it has not been made yet.

---

## How this was checked

Findings were verified by running things, not by reading.

The CloudScript has 85 assertions against a mock PlayFab sandbox covering identity
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
