// ============================================================================
//  PlayFab CloudScript — server-authoritative handlers (reference / archived)
// ----------------------------------------------------------------------------
//  This is the TRUSTED server side. The client is untrusted: it may request,
//  but only this code may decide. Never trust client-supplied identities,
//  prices, durations, or moderator flags — derive them from `currentPlayerId`
//  and from server-side configuration.
//
//  SECRETS & ENDPOINTS LIVE IN TITLE *INTERNAL* DATA (server-readable only),
//  never in this file and never in client-readable Title Data. Configure the
//  following keys in PlayFab → Title Settings → Internal Title Data:
//
//    PUN, VOICE        Photon Realtime / Voice AppIds (base64-encoded)
//    APP_ID            Oculus/Meta application id
//    APP_SECRET        Oculus/Meta application secret
//    META_HASH         Expected global-metadata hash (binary integrity)
//    IL2CPP_HASH       Expected il2cpp hash (binary integrity)
//    MODERATOR_IDS     JSON array of PlayFab ids, e.g. ["ABCD1234","EF567890"]
//    WEBHOOK_BANS      Notification endpoint: bans / anti-cheat / spoofing
//    WEBHOOK_VOICE     Notification endpoint: voice-violation reports
//    WEBHOOK_WARNINGS  Notification endpoint: anti-cheat warnings
//    WEBHOOK_REPORTS   Notification endpoint: player reports
//    WEBHOOK_LOGIN     Notification endpoint: login announcements
//    WEBHOOK_LOBBY     Notification endpoint: lobby-join announcements
//
//  If a key is not configured, the dependent handler degrades gracefully
//  (logs an error / returns an error) instead of leaking or crashing.
// ============================================================================


// ---------------------------------------------------------------------------
//  Photon authentication — returns AppIds from server-only Internal Data.
// ---------------------------------------------------------------------------
handlers.GetPhotonAuth = function (args, context) {
    var cfg = getInternalConfig(["PUN", "VOICE"]);
    var pun = cfg["PUN"];
    var voice = cfg["VOICE"];

    if (!pun || !voice) {
        return { error: "Authentication credentials not found" };
    }
    return { PUN: pun, VOICE: voice };
};


// ---------------------------------------------------------------------------
//  Launch counter — operates ONLY on the caller's own account.
//  (Hardened: never trust a client-supplied PlayFabId.)
// ---------------------------------------------------------------------------
handlers.incrementTOSandPP = function (args, context) {
    var playerId = currentPlayerId;

    var getData = server.GetUserData({
        PlayFabId: playerId,
        Keys: ["HasLaunchedBefore"]
    });

    var currentValue = 0;
    if (getData.Data && getData.Data["HasLaunchedBefore"]) {
        currentValue = parseInt(getData.Data["HasLaunchedBefore"].Value) || 0;
    }

    var newValue = currentValue + 1;
    server.UpdateUserData({
        PlayFabId: playerId,
        Data: { "HasLaunchedBefore": newValue.toString() }
    });

    return { previous: currentValue, updated: newValue };
};


// ---------------------------------------------------------------------------
//  Binary integrity — FLAGS mismatches for review rather than auto-banning,
//  because client-reported hashes are spoofable and a stale title-data update
//  would otherwise insta-ban legitimate players.
// ---------------------------------------------------------------------------
handlers.VerifyBinaryIntegrity = function (args, context) {
    var titleData = getInternalConfig(["META_HASH", "IL2CPP_HASH"]);
    var expectedMeta = titleData["META_HASH"];
    var expectedIl2cpp = titleData["IL2CPP_HASH"];

    if (!expectedMeta || !expectedIl2cpp) {
        log.warning("Integrity hashes not configured in title data.");
        return { valid: true };
    }

    var valid = (args.metaHash === expectedMeta && args.il2cppHash === expectedIl2cpp);

    if (!valid) {
        log.error("Binary integrity mismatch flagged for review.");
        server.UpdateUserReadOnlyData({
            PlayFabId: currentPlayerId,
            Data: { "IntegrityFlag": new Date().toISOString() }
        });
    }
    return { valid: valid };
};


// ---------------------------------------------------------------------------
//  Voice-violation report.
//
//  PRIVACY NOTICE: this handler forwards a recording of player voice to an
//  external service. Voice is personal data. Before enabling in production:
//    - obtain explicit, informed consent from the player,
//    - disclose the capture + third-party transfer in your privacy policy,
//    - set a retention/access policy on the receiving channel.
//  The transport here is rate-limited, size-capped, and filename-sanitized;
//  the obligation above is about the data flow, not the code.
// ---------------------------------------------------------------------------
handlers.SendVoiceToDiscord = function (args) {
    var webhookUrl = getConfigValue("WEBHOOK_VOICE");
    if (!webhookUrl) {
        return { success: false, error: "Voice reporting not configured." };
    }

    // Rate limit: 1 call / 10s per player.
    var userData = server.GetUserReadOnlyData({
        PlayFabId: currentPlayerId, Keys: ["lastVoiceReport"]
    }).Data;
    if (userData["lastVoiceReport"]) {
        var lastTime = new Date(userData["lastVoiceReport"].Value);
        if ((new Date() - lastTime) / 1000 < 10) {
            return { success: false, error: "rate_limited" };
        }
    }
    server.UpdateUserReadOnlyData({
        PlayFabId: currentPlayerId,
        Data: { lastVoiceReport: new Date().toISOString() }
    });

    var keyword = sanitize(args.keyword || "unknown");
    var audioB64 = args.audioB64 || "";
    var timestamp = Math.floor(Date.now() / 1000); // server time; ignore client

    if (!audioB64) {
        return { success: false, error: "No audio data received." };
    }

    var audioBuffer = Buffer.from(audioB64, "base64");
    var MAX_BYTES = 8 * 1024 * 1024;
    if (audioBuffer.length > MAX_BYTES) {
        return {
            success: false,
            error: "Audio too large: " + (audioBuffer.length / 1024 / 1024).toFixed(1) + " MB > 8 MB limit."
        };
    }

    var boundary = "----VoiceBoundary" + Date.now();
    var safeFileKeyword = keyword.replace(/[^a-zA-Z0-9_\-]/g, "_");
    var filename = "voice_" + safeFileKeyword + "_" + timestamp + ".wav";

    var payloadJson = JSON.stringify({
        content: "Voice violation **\"" + keyword + "\"** detected at <t:" + timestamp + ":T>. Player is " + currentPlayerId,
        username: "Voice violations",
        allowed_mentions: { parse: [] }
    });

    function buildMultipart(boundary, payloadJson, audioBuffer, filename) {
        var enc = function (s) { return Buffer.from(s, "utf8"); };
        var CRLF = "\r\n";
        var part1Header = enc(
            "--" + boundary + CRLF +
            'Content-Disposition: form-data; name="payload_json"' + CRLF +
            "Content-Type: application/json" + CRLF + CRLF);
        var part1Body = enc(payloadJson);
        var part1End = enc(CRLF);
        var part2Header = enc(
            "--" + boundary + CRLF +
            'Content-Disposition: form-data; name="files[0]"; filename="' + filename + '"' + CRLF +
            "Content-Type: audio/wav" + CRLF + CRLF);
        var closing = enc(CRLF + "--" + boundary + "--" + CRLF);
        return Buffer.concat([part1Header, part1Body, part1End, part2Header, audioBuffer, closing]);
    }

    var body = buildMultipart(boundary, payloadJson, audioBuffer, filename);

    var response = server.MakeHttpRequest({
        url: webhookUrl,
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
        body: body.toString("base64"),
        contentType: "application/octet-stream"
    });

    if (response.HttpCode === 200 || response.HttpCode === 204) {
        return { success: true, filename: filename, bytes: audioBuffer.length };
    }
    return { success: false, httpCode: response.HttpCode, detail: response.Data };
};


// ---------------------------------------------------------------------------
//  Anti-cheat ban (mods-folder detection). Client-triggered self-ban — treat
//  as friction only; authoritative checks must be ones a modded client cannot
//  skip (see VOI nonce validation and entitlement consumption).
// ---------------------------------------------------------------------------
handlers.ACB = function (args, context) {
    server.BanUsers({
        Bans: [{
            PlayFabId: currentPlayerId,
            Reason: "Anti-cheat violation."
        }]
    });

    if (webhookRateLimited("lastACB", 60)) return { success: true };

    postWebhook("WEBHOOK_BANS", {
        content: "Player '" + getDisplayName(currentPlayerId) + "' (Id: " + currentPlayerId +
                 ") was permanently banned for an anti-cheat violation."
    });
    return { success: true };
};


// ---------------------------------------------------------------------------
//  Oculus user-proof (nonce) validation — server-authoritative identity check.
// ---------------------------------------------------------------------------
handlers.VOI = function (args, context) {
    var oculusId = args.oculusId;
    var proof = args.nonce;

    var oc = oculusConfig();
    if (!oc) {
        log.error("Oculus credentials not configured.");
        return { valid: false };
    }

    var storedData = server.GetUserData({ PlayFabId: currentPlayerId, Keys: ["OculusId"] }).Data;
    if (storedData && storedData["OculusId"]) {
        if (storedData["OculusId"].Value !== oculusId) {
            log.error("Oculus ID mismatch for player: " + currentPlayerId);
            return { valid: false };
        }
    }

    var url = "https://graph.oculus.com/user_nonce_validate"
        + "?nonce=" + encodeURIComponent(proof)
        + "&user_id=" + encodeURIComponent(oculusId)
        + "&access_token=" + encodeURIComponent(oc.accessToken);

    var response = http.request(url, "POST", "", "application/json", null);
    var jsonResponse = JSON.parse(response);

    if (jsonResponse.is_valid === true) {
        return { valid: true };
    }

    log.error("Spoofing attempt detected.");
    postWebhook("WEBHOOK_BANS", {
        content: "Spoofing attempt detected for ID: " + sanitize(oculusId)
    });
    return { valid: false };
};


// ---------------------------------------------------------------------------
//  Account deletion (GDPR / privacy) — request, cancel within grace, sweep.
// ---------------------------------------------------------------------------
handlers.RequestAccountDeletion = function (args, context) {
    server.UpdateUserReadOnlyData({
        PlayFabId: currentPlayerId,
        Data: {
            "pendingDeletion": "true",
            "deletionRequestedAt": new Date().toISOString()
        }
    });
    return { message: "Account deletion requested", kick: true };
};

handlers.CheckAndCancelDeletion = function (args, context) {
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data;
    var pending = userData["pendingDeletion"];
    var timeRequested = userData["deletionRequestedAt"];

    if (pending && pending.Value === "true") {
        var diff = new Date() - new Date(timeRequested.Value);
        var twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        if (diff < twoDaysMs) {
            server.UpdateUserReadOnlyData({
                PlayFabId: currentPlayerId,
                Data: { "pendingDeletion": "false" }
            });
            return { cancelled: true, message: "Account deletion cancelled" };
        }
    }
    return { cancelled: false };
};

// WARNING: For guaranteed "right to erasure", this MUST run as a scheduled
// CloudScript task that sweeps all players with pendingDeletion past the grace
// period. As a client-triggered handler it only runs if the player returns and
// calls it, so erasure is not guaranteed. Kept here for reference.
handlers.PerformDeletionChecks = function (args, context) {
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data;
    var pending = userData["pendingDeletion"];
    var timeRequested = userData["deletionRequestedAt"];

    if (pending && pending.Value === "true") {
        var diff = new Date() - new Date(timeRequested.Value);
        var twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        if (diff >= twoDaysMs) {
            server.DeleteUser({ PlayFabId: currentPlayerId });
            return { deleted: true };
        }
    }
    return { deleted: false };
};


// ---------------------------------------------------------------------------
//  Anti-cheat warning notification.
// ---------------------------------------------------------------------------
handlers.SendWarning = function (args, context) {
    if (webhookRateLimited("lastWarning", 30)) return { result: "rate_limited" };

    var roomID = sanitize(args.roomID || "Unknown Room");
    var response = postWebhook("WEBHOOK_WARNINGS", {
        content: "Player '" + getDisplayName(currentPlayerId) + "' (Id: " + currentPlayerId +
                 ") triggered anti-cheat in room '" + roomID + "'."
    });
    return { result: response };
};


// ---------------------------------------------------------------------------
//  Player report. Authorization is derived from `currentPlayerId` (unspoofable)
//  against the server-configured moderator list — never from a client arg.
// ---------------------------------------------------------------------------
handlers.ReportPlayer = function (Args, Context) {
    var ReasonDurations = { "Hate Speech": 672, "Cheating": 168, "Toxicity": 336, "Exploiting": -1 };
    var moderator = isModerator(currentPlayerId);

    if (moderator) {
        server.BanUsers({
            Bans: [{
                PlayFabId: Args.TargetId,
                DurationInHours: ReasonDurations[Args.Reason] || 24,
                Reason: Args.Reason || "Moderator ban"
            }]
        });
        return { Result: "Banned Player" };
    }

    if (webhookRateLimited("lastReport", 10)) return { Result: "rate_limited" };

    var Embed = {
        title: "Player Report",
        color: 16711680,
        fields: [
            { name: "**Reported**", value: sanitize(Args.TargetId) + "\n" + sanitize(Args.TargetName) + "\n#" + sanitize(Args.TargetColor), inline: true },
            { name: "**Reporter**", value: currentPlayerId + "\n" + sanitize(Args.ReporterName) + "\n#" + sanitize(Args.ReporterColor), inline: true },
            { name: "**Details**", value: "Room: " + sanitize(Args.Room) + "\nReason: " + sanitize(Args.Reason) },
            { name: "**IsModerator**", value: String(moderator) }
        ]
    };

    postWebhook("WEBHOOK_REPORTS", { embeds: [Embed] });
    return { Result: "Report Sent" };
};


// ---------------------------------------------------------------------------
//  Presence announcements (login / lobby join).
// ---------------------------------------------------------------------------
handlers.AnnounceLogin = function (args, context) {
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data;
    if (userData["lastLoginAnnounce"]) {
        if ((new Date() - new Date(userData["lastLoginAnnounce"].Value)) / 1000 < 30) {
            return { result: "rate_limited" };
        }
    }
    server.UpdateUserReadOnlyData({
        PlayFabId: currentPlayerId,
        Data: { lastLoginAnnounce: new Date().toISOString() }
    });

    var response = postWebhook("WEBHOOK_LOGIN", {
        content: "Player " + getDisplayName(currentPlayerId) + " with the Id " + currentPlayerId + " just logged in."
    });
    return { result: response };
};

handlers.AnnounceLobbyJoin = function (args, context) {
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data;
    if (userData["lastLobbyAnnounce"]) {
        if ((new Date() - new Date(userData["lastLobbyAnnounce"].Value)) / 1000 < 10) {
            return { result: "rate_limited" };
        }
    }
    server.UpdateUserReadOnlyData({
        PlayFabId: currentPlayerId,
        Data: { lastLobbyAnnounce: new Date().toISOString() }
    });

    var safeRoomID = sanitize(args.roomID);
    var safeNumberOfPlayers = sanitize(args.numberOfPlayers);
    var response = postWebhook("WEBHOOK_LOBBY", {
        content: "Player '" + getDisplayName(currentPlayerId) + " with the Id " + currentPlayerId +
                 "' joined room '" + safeRoomID + "'. There are " + safeNumberOfPlayers + " players in this room."
    });
    return { result: response };
};


// ---------------------------------------------------------------------------
//  In-app purchases — entitlement is consumed against Oculus BEFORE anything
//  is granted, and the SKU→amount mapping is server-side. No client-supplied
//  prices or amounts are ever trusted.
// ---------------------------------------------------------------------------
handlers.CompleteIAPPurchase = function (args, context) {
    if (!verifyOculusIdMatches(currentPlayerId, args.MetaId)) {
        log.error("MetaId mismatch for IAP. Player: " + currentPlayerId);
        return false;
    }

    var oc = oculusConfig();
    if (!oc) { log.error("Oculus credentials not configured."); return false; }

    var url = "https://graph.oculus.com/" + oc.appId + "/consume_entitlement"
        + "?nonce=" + encodeURIComponent(args.UserProof)
        + "&user_id=" + encodeURIComponent(args.MetaId)
        + "&sku=" + encodeURIComponent(args.Sku)
        + "&access_token=" + encodeURIComponent(oc.accessToken);

    var responseString = http.request(url, "post", "", "application/json", {});
    var parsed;
    try { parsed = JSON.parse(responseString); } catch (e) { return false; }
    return parsed && parsed.success === true;
};

handlers.GrantOculusCurrency = function (args, context) {
    if (!verifyOculusIdMatches(currentPlayerId, args.MetaId)) {
        log.error("MetaId mismatch for currency grant. Player: " + currentPlayerId);
        return { success: false, error: "Account mismatch." };
    }

    var currencyMap = {
        "buyonethousand": 1000,
        "buyfivethousand": 5000,
        "buytenthousand": 10000
    };
    var currencyAmount = currencyMap[args.Sku];
    if (!currencyAmount) return { success: false, error: "Invalid SKU." };

    var oc = oculusConfig();
    if (!oc) { log.error("Oculus credentials not configured."); return { success: false, error: "Verification failed." }; }

    var consumeUrl = "https://graph.oculus.com/" + oc.appId + "/consume_entitlement"
        + "?nonce=" + encodeURIComponent(args.UserProof)
        + "&user_id=" + encodeURIComponent(args.MetaId)
        + "&sku=" + encodeURIComponent(args.Sku)
        + "&access_token=" + encodeURIComponent(oc.accessToken);

    var consumeResponse;
    try {
        consumeResponse = JSON.parse(http.request(consumeUrl, "post", "", "application/json", {}));
    } catch (e) {
        return { success: false, error: "Verification failed." };
    }

    if (!consumeResponse || !consumeResponse.success) {
        log.error("Entitlement consume failed. Player: " + currentPlayerId + " SKU: " + sanitize(args.Sku));
        return { success: false, error: "Purchase could not be verified." };
    }

    var result = server.AddUserVirtualCurrency({
        PlayFabId: currentPlayerId,
        VirtualCurrency: "MC",
        Amount: currencyAmount
    });
    return { success: true, newBalance: result.Balance };
};


// ---------------------------------------------------------------------------
//  Self-ban helpers (client-triggered; friction only). Inputs are validated
//  and sanitized server-side rather than trusted as-is.
// ---------------------------------------------------------------------------
handlers.banPlayer = function (args, context) {
    var hours = (typeof args.duration === "number" && args.duration > 0) ? args.duration : 24;
    return server.BanUsers({
        Bans: [{
            PlayFabId: currentPlayerId,
            DurationInHours: hours,
            Reason: sanitize(args.reason)
        }]
    });
};

handlers.permBanPlayer = function (args, context) {
    var result = server.BanUsers({
        Bans: [{ PlayFabId: currentPlayerId, Reason: sanitize(args.reason) }]
    });

    if (!webhookRateLimited("lastPermBan", 60)) {
        postWebhook("WEBHOOK_BANS", {
            content: "Player '" + getDisplayName(currentPlayerId) + "' (Id: " + currentPlayerId +
                     ") has been permanently banned. Reason: " + sanitize(args.reason)
        });
    }
    return { success: true, result: result };
};


// ---------------------------------------------------------------------------
//  Voice mute — MODERATION action. Only moderators may set it, and it targets
//  another player. (Hardened: previously any player could set/clear their own
//  VoiceMutedUntil, which allowed self-unmute / mute evasion.)
// ---------------------------------------------------------------------------
handlers.setVoiceMute = function (args, context) {
    if (!isModerator(currentPlayerId)) {
        return { error: "Not authorized." };
    }
    var targetId = args.targetPlayFabId;
    if (!targetId) {
        return { error: "Missing targetPlayFabId." };
    }
    var durationSeconds = args.durationSeconds;
    if (typeof durationSeconds !== "number" || durationSeconds < 0 || durationSeconds > 2592000) {
        return { error: "Invalid duration. Must be between 0 and 2592000 seconds (30 days)." };
    }

    var mutedUntil = "";
    if (durationSeconds > 0) {
        var now = new Date();
        now.setSeconds(now.getSeconds() + durationSeconds);
        mutedUntil = now.toISOString();
    }

    server.UpdateUserReadOnlyData({
        PlayFabId: targetId,
        Data: { VoiceMutedUntil: mutedUntil }
    });

    return { mutedUntil: mutedUntil, target: targetId };
};


// ============================================================================
//  Helpers
// ============================================================================

// Title Internal Data is server-only. Values are returned as plain strings
// (unlike User Data, whose entries are { Value: "..." }).
function getInternalConfig(keys) {
    var res = server.GetTitleInternalData({ Keys: keys });
    return (res && res.Data) ? res.Data : {};
}

function getConfigValue(key) {
    var data = getInternalConfig([key]);
    return data[key] || null;
}

// Posts JSON to a configured webhook. Always disables mentions at the payload
// level as defense-in-depth; sanitize() is only a last-resort scrub.
function postWebhook(configKey, payload) {
    var url = getConfigValue(configKey);
    if (!url) {
        log.error("Webhook not configured: " + configKey);
        return null;
    }
    if (payload && !payload.allowed_mentions) {
        payload.allowed_mentions = { parse: [] };
    }
    return http.request(url, "post", JSON.stringify(payload), "application/json", {});
}

// Moderator allow-list from Title Internal Data (JSON array of PlayFab ids).
function isModerator(playFabId) {
    var raw = getConfigValue("MODERATOR_IDS");
    if (!raw) return false;
    var list;
    try { list = JSON.parse(raw); } catch (e) { return false; }
    return Array.isArray(list) && list.indexOf(playFabId) !== -1;
}

// Oculus/Meta app credentials from server-only Internal Data.
function oculusConfig() {
    var cfg = getInternalConfig(["APP_ID", "APP_SECRET"]);
    var appId = cfg["APP_ID"];
    var appSecret = cfg["APP_SECRET"];
    if (!appId || !appSecret) return null;
    return { appId: appId, accessToken: "OC|" + appId + "|" + appSecret };
}

function getDisplayName(playFabId) {
    var profileResult = server.GetPlayerProfile({
        PlayFabId: playFabId,
        ProfileConstraints: { ShowDisplayName: true }
    });
    return sanitize(profileResult.PlayerProfile
        ? profileResult.PlayerProfile.DisplayName : "Unknown");
}

function sanitize(str) {
    if (str === null || str === undefined) return "Unknown";
    str = String(str);
    // Last-resort mention scrub; real defense is allowed_mentions:{parse:[]}.
    return str.replace(/@(everyone|here|&)/g, "[@removed]").substring(0, 100);
}

function verifyOculusIdMatches(playfabId, claimedOculusId) {
    var stored = server.GetUserData({
        PlayFabId: playfabId,
        Keys: ["OculusId"]
    }).Data;
    if (!stored || !stored["OculusId"]) return false;
    return stored["OculusId"].Value === claimedOculusId;
}

// Per-player webhook throttle, backed by server-written ReadOnlyData so the
// client cannot tamper with the timestamps.
function webhookRateLimited(key, seconds) {
    var d = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId, Keys: [key] }).Data;
    if (d[key]) {
        if ((new Date() - new Date(d[key].Value)) / 1000 < seconds) return true;
    }
    var update = {};
    update[key] = new Date().toISOString();
    server.UpdateUserReadOnlyData({ PlayFabId: currentPlayerId, Data: update });
    return false;
}
