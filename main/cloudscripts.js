handlers.GetPhotonAuth = function (args, context) {
    var cfg = getInternalConfig(["PUN", "VOICE", "ALLOW_UNVERIFIED_PHOTON"]);
    var pun = cfg["PUN"];
    var voice = cfg["VOICE"];

    if (!pun || !voice) {
        return { error: "Authentication credentials not found" };
    }

    var devBypass = (cfg["ALLOW_UNVERIFIED_PHOTON"] === "true");
    if (!devBypass && !isIdentityVerified(currentPlayerId, IDENTITY_MAX_AGE_SECONDS)) {
        log.error("GetPhotonAuth denied: identity not verified. Player: " + currentPlayerId);
        return { error: "Identity not verified" };
    }

    return { PUN: pun, VOICE: voice };
};

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

handlers.VerifyBinaryIntegrity = function (args, context) {
    args = args || {};
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

handlers.SendVoiceToDiscord = function (args) {
    args = args || {};
    var webhookUrl = getConfigValue("WEBHOOK_VOICE");
    if (!webhookUrl) {
        return { success: false, error: "Voice reporting not configured." };
    }

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
    var audioB64 = args.audioB64;
    var timestamp = Math.floor(Date.now() / 1000);

    if (!isNonEmptyString(audioB64)) {
        return { success: false, error: "No audio data received." };
    }

    var MAX_BYTES = 8 * 1024 * 1024;
    var MAX_B64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;
    if (audioB64.length > MAX_B64_CHARS) {
        return { success: false, error: "Audio too large: exceeds the 8 MB limit." };
    }

    var audioBuffer;
    try {
        audioBuffer = Buffer.from(audioB64, "base64");
    } catch (e) {
        return { success: false, error: "Audio data could not be decoded." };
    }
    if (!audioBuffer || audioBuffer.length === 0) {
        return { success: false, error: "Audio data could not be decoded." };
    }
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

handlers.VOI = function (args, context) {
    args = args || {};
    var oculusId = args.oculusId;
    var proof = args.nonce;

    if (!isNonEmptyString(oculusId) || !isNonEmptyString(proof)) {
        log.error("VOI called with missing/invalid arguments. Player: " + currentPlayerId);
        return { valid: false };
    }

    var oc = oculusConfig();
    if (!oc) {
        log.error("Oculus credentials not configured.");
        return { valid: false };
    }

    var binding = getIdentityBinding(currentPlayerId);
    if (binding.oculusId && binding.oculusId !== oculusId) {
        log.error("Oculus ID mismatch for player: " + currentPlayerId);
        reportSpoofingAttempt(oculusId, "bound account claimed by a different Oculus id");
        return { valid: false };
    }

    var body = "nonce=" + encodeURIComponent(proof)
        + "&user_id=" + encodeURIComponent(oculusId)
        + "&access_token=" + encodeURIComponent(oc.accessToken);

    var jsonResponse = postGraphRequest("https://graph.oculus.com/user_nonce_validate", body);
    if (jsonResponse === null) {

        log.error("Oculus nonce validation failed to return a usable response.");
        return { valid: false };
    }

    if (jsonResponse.is_valid === true) {

        setIdentityBinding(currentPlayerId, oculusId);
        return { valid: true };
    }

    log.error("Spoofing attempt detected.");
    reportSpoofingAttempt(oculusId, "nonce validation rejected by Oculus");
    return { valid: false };
};

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
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data || {};
    var pending = userData["pendingDeletion"];
    var timeRequested = userData["deletionRequestedAt"];

    if (pending && pending.Value === "true" && timeRequested) {
        var diff = new Date() - new Date(timeRequested.Value);
        var twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        if (!isNaN(diff) && diff < twoDaysMs) {
            server.UpdateUserReadOnlyData({
                PlayFabId: currentPlayerId,
                Data: { "pendingDeletion": "false" }
            });
            return { cancelled: true, message: "Account deletion cancelled" };
        }
    }
    return { cancelled: false };
};

handlers.PerformDeletionChecks = function (args, context) {
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data || {};
    var pending = userData["pendingDeletion"];
    var timeRequested = userData["deletionRequestedAt"];

    if (pending && pending.Value === "true" && timeRequested) {
        var diff = new Date() - new Date(timeRequested.Value);
        var twoDaysMs = 2 * 24 * 60 * 60 * 1000;
        if (!isNaN(diff) && diff >= twoDaysMs) {
            server.DeleteUser({ PlayFabId: currentPlayerId });
            return { deleted: true };
        }
    }
    return { deleted: false };
};

handlers.SendWarning = function (args, context) {
    args = args || {};
    if (webhookRateLimited("lastWarning", 30)) return { result: "rate_limited" };

    var roomID = sanitize(args.roomID || "Unknown Room");
    var response = postWebhook("WEBHOOK_WARNINGS", {
        content: "Player '" + getDisplayName(currentPlayerId) + "' (Id: " + currentPlayerId +
                 ") triggered anti-cheat in room '" + roomID + "'."
    });
    return { result: response };
};

handlers.ReportPlayer = function (Args, Context) {
    Args = Args || {};

    var ReasonDurations = { "Hate Speech": 672, "Cheating": 168, "Toxicity": 336 };

    var PermanentReasons = { "Exploiting": true };

    var moderator = isModerator(currentPlayerId);

    if (moderator) {
        var targetId = Args.TargetId;
        if (!isNonEmptyString(targetId)) {
            return { Result: "Invalid TargetId." };
        }
        if (targetId === currentPlayerId) {
            return { Result: "Cannot ban yourself." };
        }
        if (isModerator(targetId)) {
            log.error("Moderator " + currentPlayerId + " attempted to ban moderator " + targetId);
            return { Result: "Cannot ban another moderator." };
        }
        if (webhookRateLimited("lastModBan", 5)) return { Result: "rate_limited" };

        var reason = isNonEmptyString(Args.Reason) ? Args.Reason : "Moderator ban";
        var ban = { PlayFabId: targetId, Reason: sanitize(reason) };
        if (!has(PermanentReasons, reason)) {
            ban.DurationInHours = has(ReasonDurations, reason) ? ReasonDurations[reason] : 24;
        }

        server.BanUsers({ Bans: [ban] });
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

handlers.AnnounceLogin = function (args, context) {
    args = args || {};
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data || {};
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
    args = args || {};
    var userData = server.GetUserReadOnlyData({ PlayFabId: currentPlayerId }).Data || {};
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

handlers.CompleteIAPPurchase = function (args, context) {
    args = args || {};
    if (!isNonEmptyString(args.MetaId) || !isNonEmptyString(args.UserProof) || !isNonEmptyString(args.Sku)) {
        return false;
    }
    if (!verifyOculusIdMatches(currentPlayerId, args.MetaId)) {
        log.error("MetaId mismatch for IAP. Player: " + currentPlayerId);
        return false;
    }

    var oc = oculusConfig();
    if (!oc) { log.error("Oculus credentials not configured."); return false; }

    var parsed = consumeEntitlement(oc, args.MetaId, args.UserProof, args.Sku);
    return parsed !== null && parsed.success === true;
};

handlers.GrantOculusCurrency = function (args, context) {
    args = args || {};
    if (!isNonEmptyString(args.MetaId) || !isNonEmptyString(args.UserProof) || !isNonEmptyString(args.Sku)) {
        return { success: false, error: "Invalid request." };
    }
    if (!verifyOculusIdMatches(currentPlayerId, args.MetaId)) {
        log.error("MetaId mismatch for currency grant. Player: " + currentPlayerId);
        return { success: false, error: "Account mismatch." };
    }

    var currencyMap = {
        "buyonethousand": 1000,
        "buyfivethousand": 5000,
        "buytenthousand": 10000
    };
    if (!has(currencyMap, args.Sku)) return { success: false, error: "Invalid SKU." };
    var currencyAmount = currencyMap[args.Sku];

    var oc = oculusConfig();
    if (!oc) { log.error("Oculus credentials not configured."); return { success: false, error: "Verification failed." }; }

    var consumeResponse = consumeEntitlement(oc, args.MetaId, args.UserProof, args.Sku);
    if (consumeResponse === null || !consumeResponse.success) {
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

handlers.banPlayer = function (args, context) {
    args = args || {};
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
    args = args || {};
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

handlers.setVoiceMute = function (args, context) {
    args = args || {};
    if (!isModerator(currentPlayerId)) {
        return { error: "Not authorized." };
    }
    var targetId = args.targetPlayFabId;
    if (!isNonEmptyString(targetId)) {
        return { error: "Missing targetPlayFabId." };
    }
    if (isModerator(targetId)) {
        return { error: "Cannot mute another moderator." };
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

var IDENTITY_MAX_AGE_SECONDS = 24 * 60 * 60;

function isNonEmptyString(v) {
    return typeof v === "string" && v.length > 0;
}

function has(obj, key) {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

function getIdentityBinding(playFabId) {
    var res = server.GetUserInternalData({
        PlayFabId: playFabId,
        Keys: ["OculusId", "IdentityVerifiedAt"]
    });
    var data = (res && res.Data) ? res.Data : {};
    return {
        oculusId: data["OculusId"] ? data["OculusId"].Value : null,
        verifiedAt: data["IdentityVerifiedAt"] ? data["IdentityVerifiedAt"].Value : null
    };
}

function setIdentityBinding(playFabId, oculusId) {
    server.UpdateUserInternalData({
        PlayFabId: playFabId,
        Data: {
            "OculusId": oculusId,
            "IdentityVerifiedAt": new Date().toISOString()
        }
    });
}

function isIdentityVerified(playFabId, maxAgeSeconds) {
    var binding = getIdentityBinding(playFabId);
    if (!binding.oculusId || !binding.verifiedAt) return false;
    var age = (new Date() - new Date(binding.verifiedAt)) / 1000;
    if (isNaN(age)) return false;

    return age >= 0 && age < maxAgeSeconds;
}

function reportSpoofingAttempt(oculusId, detail) {
    if (webhookRateLimited("lastSpoofAlert", 300)) return;
    postWebhook("WEBHOOK_BANS", {
        content: "Spoofing attempt detected for ID: " + sanitize(oculusId) +
                 " (" + sanitize(detail) + "). Player: " + currentPlayerId
    });
}

function postGraphRequest(url, body) {
    var responseString;
    try {
        responseString = http.request(url, "post", body,
            "application/x-www-form-urlencoded", null, false);
    } catch (e) {
        log.error("Oculus Graph request failed.");
        return null;
    }
    try {
        return JSON.parse(responseString);
    } catch (e) {
        log.error("Oculus Graph returned an unparseable response.");
        return null;
    }
}

function consumeEntitlement(oc, metaId, userProof, sku) {
    var body = "nonce=" + encodeURIComponent(userProof)
        + "&user_id=" + encodeURIComponent(metaId)
        + "&sku=" + encodeURIComponent(sku)
        + "&access_token=" + encodeURIComponent(oc.accessToken);
    return postGraphRequest(
        "https://graph.oculus.com/" + encodeURIComponent(oc.appId) + "/consume_entitlement",
        body);
}

function getInternalConfig(keys) {
    var res = server.GetTitleInternalData({ Keys: keys });
    return (res && res.Data) ? res.Data : {};
}

function getConfigValue(key) {
    var data = getInternalConfig([key]);
    return data[key] || null;
}

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

function isModerator(playFabId) {
    var raw = getConfigValue("MODERATOR_IDS");
    if (!raw) return false;
    var list;
    try { list = JSON.parse(raw); } catch (e) { return false; }
    return Array.isArray(list) && list.indexOf(playFabId) !== -1;
}

function oculusConfig() {
    var cfg = getInternalConfig(["APP_ID", "APP_SECRET"]);
    var appId = cfg["APP_ID"];
    var appSecret = cfg["APP_SECRET"];
    if (!appId || !appSecret) return null;
    return { appId: appId, accessToken: "OC|" + appId + "|" + appSecret };
}

function getDisplayName(playFabId) {
    try {
        var profileResult = server.GetPlayerProfile({
            PlayFabId: playFabId,
            ProfileConstraints: { ShowDisplayName: true }
        });
        return sanitize(profileResult && profileResult.PlayerProfile
            ? profileResult.PlayerProfile.DisplayName : "Unknown");
    } catch (e) {
        return "Unknown";
    }
}

function sanitize(str) {
    if (str === null || str === undefined) return "Unknown";
    str = String(str);

    return str.replace(/@(everyone|here|&)/g, "[@removed]").substring(0, 100);
}

function verifyOculusIdMatches(playfabId, claimedOculusId) {
    if (!isNonEmptyString(claimedOculusId)) return false;
    var binding = getIdentityBinding(playfabId);
    if (!binding.oculusId) return false;
    if (binding.oculusId !== claimedOculusId) return false;
    return isIdentityVerified(playfabId, IDENTITY_MAX_AGE_SECONDS);
}

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
