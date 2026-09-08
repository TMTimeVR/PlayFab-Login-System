# PlayFab-Login-System
A login system for VR games made for Oculus Quest.

# Dependencies

- [The PlayFab Unity SDK](https://github.com/PlayFab/UnitySDK) [(Download)](https://aka.ms/PlayFabUnitySdk)
- [Photon VR (I used my forked version of it but I don't think it will be necessary to use it)](https://github.com/fchb1239/PhotonVR) [Forked version](https://github.com/TMTimeVR/PhotonVR)
- [The Meta XR All-in-One SDK](https://assetstore.unity.com/packages/tools/integration/meta-xr-all-in-one-sdk-269657)
- TextMeshPro
- [Glitched Cat Studios's Wardrobe System](https://github.com/Glitched-Cat-Studios/GCS-Wardrobe)

# DISCLAIMER:

**Yes, AI (Claude) was used in this system. Claude was used as a second pair of eyes, not just something that generates code that I instantly put into this system.**
This is (probably) a safe and secure backend. I dunno, don't take my word on it. This is an older version of the backend in [Monkey Mall](https://www.meta.com/en-gb/experiences/chimpstitute/6878051502218331/).

This isn't enterprise-ready. Use this for your hobby project, or to just inspire yourself.

# Credits:

I used large code snippets of SolarisDev09's [AdvancedPlayFab](https://github.com/SolarisDev09/AdvancedPlayfab?tab=readme-ov-file) and JokerJosh0's [EasyPlayFab](https://github.com/JokerJosh0/EasyPlayfab).
I also used [some random PlayFab login script from 2023](https://github.com/TMTimeVR/PlayFab-Login-System/blob/main/SomeRandomPlayFabLoginScriptFrom2023.cs). I think it was made by someone called "MONKI".

The APK hash verification snippet (`IsGameRunning` in `main/LoginPF.cs`) was made by [MaxNiftyNine](https://github.com/MaxNiftyNine), following [this guide](https://github.com/TMTimeVR/PlayFab-Login-System/raw/refs/heads/main/guide/How%20to%20add%20anticheat%20to%20your%20gorilla%20tag%20fan%20game%20(stop%20moddinghacking).mp4).

That doesn't make this a pile of other people's snippets. A big part of the code is mine.

# Setup:

1. **Import the dependencies.** Import the PlayFab Unity SDK, Photon PUN, Photon Voice, PhotonVR, the GCS Wardrobe System and the Meta XR All-in-One SDK. If you are prompted to import TextMeshPro, do so.

2. **Add the scripts.** Place [`main/LoginPF.cs`](main/LoginPF.cs) in your project (e.g. `Assets/Scripts/`). The `creditsURL`, `motdURL`, `uURL`, `ltURL` and `woURL` fields near the top point at placeholder URLs (`YOUR_USERNAME/YOUR_REPO`). Change them to your own remote text files, or delete the features that use them if you don't want a MOTD, credits or version gate.

3. **Enable the PlayFab API features.** In the PlayFab Game Manager, open **Settings → API Features**:

   ![](guide/enable%20settings.png)

   Enable the options shown here:

   ![](guide/APIFeatures.png)

4. **Set your Title ID.** In Unity, click **PlayFab → MakePlayFabSharedSettings** at the top of the window and enter your Title ID:

   ![](guide/AddTitleID.png)

5. **Upload the Cloud Script.** `LoginPF.cs` relies on server-side handlers (`VOI`, `GetPhotonAuth`, `AnnounceLogin`, `banPlayer`, `permBanPlayer`, and more). In the Game Manager, go to **Automation → Cloud Script**, paste the contents of [`main/cloudscripts.js`](main/cloudscripts.js) into a new revision, save it, and **deploy it as the live revision**.

6. **Configure your secrets in Internal Title Data.** The Cloud Script reads every secret and endpoint from server-only Internal Title Data. Never put these in client-readable Title Data, and never hard-code them in the scripts. In the Game Manager, open **Content → Title Data → Internal Title Data** and add the keys you need:

   | Key | Purpose |
   |-----|---------|
   | `PUN` | Photon Realtime AppId (base64-encoded) |
   | `VOICE` | Photon Voice AppId (base64-encoded) |
   | `APP_ID` | Meta/Oculus application ID |
   | `APP_SECRET` | Meta/Oculus application secret |
   | `MODERATOR_IDS` | JSON array of moderator PlayFab IDs, e.g. `["ABC123","DEF456"]` |
   | `ALLOW_UNVERIFIED_PHOTON` | Development only. Leave unset in production. See the note below. |
   | `WEBHOOK_BANS`, `WEBHOOK_VOICE`, `WEBHOOK_WARNINGS`, `WEBHOOK_REPORTS`, `WEBHOOK_LOGIN`, `WEBHOOK_LOBBY` | Notification endpoints. Optional, and handlers still work if a key is unset. |
   | `META_HASH`, `IL2CPP_HASH` | Expected build hashes for the optional binary-integrity check. Optional. |

   **How identity verification works.** `VOI` checks the player's Oculus nonce with Meta. Only if Meta says yes does it write the Oculus ID into User Internal Data, which the server can write and the client cannot. `GetPhotonAuth` then refuses to return the Photon AppIds unless that verification exists and is under 24 hours old.

   That gate is the whole point. `LoginPF.cs` also calls `FC()` when `VOI` fails, but a modded client deletes that line, so the client-side half enforces nothing. Withholding the AppIds happens on the server, and an unverified session cannot reach multiplayer without them.

   Do not store the Oculus ID from the client. Any client can overwrite its own User Data through `UpdateUserData`, so what the client puts there is a claim, not a fact.

   `ALLOW_UNVERIFIED_PHOTON` exists because the Unity Editor has no real Oculus nonce to check, so `LoginPF.cs` skips `VOI` under `#if UNITY_EDITOR`. Setting it to `"true"` lets editor sessions connect. Setting it in production turns the gate off for everyone.

7. **Set up the GCS Wardrobe.** Follow the [GCS Wardrobe setup guide](guide/GCSWARDROBETUTORIAL.mp4) (made by The Tech Wizard).

   One thing to know: GCS-Wardrobe checks cosmetic ownership only in the local UI. Equipping calls `PhotonVRManager.SetCosmetic(...)`, which writes a string into the player's Photon custom properties, and other clients activate whatever name arrives. So a modded client can wear a cosmetic it never bought. Nothing is actually granted, so it is spoofing rather than theft, but if rare cosmetics are your reward loop it defeats the point. Check the equipped ID against the server-side inventory before broadcasting it.

8. **(Optional) Enable the APK signature check.** `LoginPF.cs` has an `EXPECTED_SIGNATURE_HASH` constant. Left at `0` the check is off and the game runs normally. To turn it on, set it to your release keystore signature's `hashCode` (see [MaxNiftyNine's guide](guide/How%20to%20add%20anticheat%20to%20your%20gorilla%20tag%20fan%20game%20%28stop%20moddinghacking%29.mp4)). It runs on the client, so it is a speed bump. Anyone can patch it out of a decompiled APK. Never make it your only protection.

> **Security note.** This is client code and cannot be trusted. Keep every secret in Internal Title Data, and put anything that matters inside Cloud Script: identity checks, currency and purchase grants, bans. Never on the client.

# Security

A full review of this project and its dependencies is in [reports/security-review.md](reports/security-review.md). It covers what was found, what was fixed, and what is still open. Found something it missed? [SECURITY.md](SECURITY.md) has contact details.

# Should I use this for my hobby project?
As a starting point, sure. I would not drop it into a game and assume authentication is solved. Read the review first.
