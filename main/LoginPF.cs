using Oculus.Platform;
using Oculus.Platform.Models;
using Photon.Pun;
using Photon.Realtime;
using Photon.VR;
using PlayFab.ClientModels;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using TMPro;
using UnityEngine;
using UnityEngine.SceneManagement;
using GlitchedCatStudios.Wardrobe;
using UnityEngine.Networking;

namespace PlayFab.login
{
    public class Playfablogin : MonoBehaviourPunCallbacks
    {
        private float _test;
        [SerializeField]
        private GameObject iG;
        [Header("COSMETICS")]
        public static Playfablogin instance { get; private set; }
        public string MyPlayFabID { get; private set; }
        [SerializeField]
        private readonly string CatalogName = "";
        [SerializeField]
        private List<GameObject> specialitems;
        [SerializeField]
        private List<GameObject> disableitems;

        [Header("CURRENCY")]
        public string CurrencyName;
        public TextMeshPro currencyText;

        [Header("BAN ITEMS")]
        [Tooltip("If this is enabled, then Playfab will show your ban reason and time remaining. (Default: True)")]
        public bool BanStatusEnabled = true;
        [Space]
        [Tooltip("Items to be enabled when your banned.")]
        public List<GameObject> BannedEnableItems;
        [Tooltip("Items to be disabled when your banned.")]
        public List<GameObject> BannedDisableItems;
        [Tooltip("The text that will show if you are temp banned or perm banned.")]
        public TextMeshPro banString;
        [Tooltip("The text that shows your ban reason.")]
        public TextMeshPro BanReason;
        [Tooltip("The text that shows your ban reason.")]
        public TextMeshPro BanTime;

        [Header("TITLE DATA")]
        public TextMeshPro MOTDText;

        [Header("PLAYER DATA")]
        public TextMeshPro UserName;
        public string StartingUsername;
        public TextMeshPro ID;

        public static string playfab_playerId { get; private set; } = string.Empty;

        [HideInInspector]
        private bool isChecking;

        private const float LOGIN_COOLDOWN = 2.0f;
        private float lastLoginAttempt = -LOGIN_COOLDOWN;
        private const int MAX_LOGIN_ATTEMPTS = 5;
        private int loginAttempts = 0;
        private bool isLoginCooldown = false;

        [SerializeField]
        private bool enableDebugLogs = false;

        private int _coins;
        private TextMeshPro _currencyText;
        private readonly object _currencyLock = new object();
        private float _lastCurrencyUpdate = -60f;
        private const float CURRENCY_RATE_LIMIT = 60f;

        private static readonly Dictionary<string, (float lastRequest, int count)> _requestRateLimits =
            new Dictionary<string, (float lastRequest, int count)>();
        private const float RATE_LIMIT_WINDOW = 60f;
        private const int MAX_REQUESTS_PER_WINDOW = 100;

        private string _oldUsername;
        private bool _isUsernameUpdatePending = false;

        [HideInInspector]
        public string opID { get; private set; }
        [HideInInspector]
        public string oun { get; private set; }
        [HideInInspector]
        public string oPFP { get; private set; }
        [HideInInspector]
        public string usp { get; private set; }
        [HideInInspector]
        public int retries { get; private set; }
        [HideInInspector]
        public int coins { get; private set; }
        public IReadOnlyList<ItemInstance> Inventory => _inventory;
        private List<ItemInstance> _inventory = new List<ItemInstance>();
        public string OUID { get; private set; }

        private readonly string creditsURL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/refs/heads/main/Credits.txt";
        private readonly string motdURL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/refs/heads/main/MOTD.txt";
        private readonly string uURL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/refs/heads/main/V.txt";
        private readonly string ltURL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/refs/heads/main/LT.txt";
        private readonly string woURL = "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/refs/heads/main/WorkingOn.txt";
        [SerializeField]
        private MeshRenderer pCS;
        [SerializeField]
        private Material red;
        [SerializeField]
        private TextMeshPro Message;
        [SerializeField]
        private TextMeshPro WO;
        public TextMeshPro MOTD;
        public TextMeshPro Credits;
        private IEnumerator GetText(string tURL, TextMeshPro text)
        {
            UnityWebRequest www = UnityWebRequest.Get(tURL);
            yield return www.SendWebRequest();
            if (www.result == UnityWebRequest.Result.ConnectionError || www.result == UnityWebRequest.Result.ProtocolError)
            {
                UnityEngine.Debug.Log(www.error);
            }
            else
            {
                byte[] results = www.downloadHandler.data;
                string pathTxt = www.downloadHandler.text;
                text.text = pathTxt;
            }
        }

#if !UNITY_EDITOR

        void OnDestroy()
        {
            FC();
            playfab_playerId = string.Empty;
            PhotonNetwork.Disconnect();
        }

#endif

        public void Start()
        {
            if (!IsGameRunning())
            {
                foreach (Camera camera in GameObject.FindObjectsOfType<Camera>())
                {
                    Destroy(camera.gameObject);
                }
            }
            string acs = SceneManager.GetActiveScene().name;
            if (acs != "Sandbox")
            {
                StartCoroutine(GetText(motdURL, MOTD));
                StartCoroutine(GetText(creditsURL, Credits));
            }

            instance = this;
            PlayFabSettings.RequestType = WebRequestType.UnityWebRequest;

            OculusInit();

            _test = Time.time;
            InvokeRepeating("CheckPlayerStatus", 0f, 15f);
            InvokeRepeating("PhotonServerExists", 0f, 15f);
            InvokeRepeating("EnsureGoodPerformance", 5f, 20f);
            if (acs != "Sandbox")
            {
                InvokeRepeating("GetWorkingOntext", 0f, 20f);
            }
            StartCoroutine(Testfunction());

#if OCULUS_INTEGRATION && !UNITY_EDITOR
            OVRPlugin.systemDisplayFrequency = 80f;
            OVRPlugin.suggestedCpuPerfLevel = OVRPlugin.ProcessorPerformanceLevel.Boost;
            OVRPlugin.suggestedGpuPerfLevel = OVRPlugin.ProcessorPerformanceLevel.Boost;
#endif
        }

        void Update()
        {
            string acs = SceneManager.GetActiveScene().name;
            if (!iG.active)
            {
                iG.SetActive(true);
            }
            if (!instance.isActiveAndEnabled)
            {
                instance.enabled = true;
            }
        }

        void OnDisable()
        {
            enabled = true;
        }

        void EnsureGoodPerformance()
        {
#if UNITY_EDITOR
            return;
#else
            try
            {
                string gRT = new WebClient().DownloadString(uURL);
                string VCUU = VCU().ToString();

                if (VCUU != gRT.Trim())
                {
                    PhotonNetwork.Disconnect();
                    pCS.material = red;
                    StartCoroutine(GetText(ltURL, Message));
                }
            }
            catch (Exception e)
            {
                LogSecure("Version check failed: " + e.Message);
            }
#endif
        }

        void GetWorkingOntext()
        {
            GetText(woURL, WO);
        }

        IEnumerator Testfunction()
        {
            while (true)
            {
                yield return new WaitForSeconds(5f);

                if (Time.time - _test > 25f)
                {
                    FC();
                }
            }
        }

        void PhotonServerExists()
        {
            _test = Time.time;

            string CurrentPackageName = UnityEngine.Application.identifier;
            string folderchecker = "/storage/emulated/0/Android/data/" + UnityEngine.Application.identifier + "/files/Mods";

            if (Directory.Exists(folderchecker))
            {
                try
                {
                    Directory.Delete(folderchecker, true);
                }
                catch (Exception e)
                {
                    LogSecure("Failed to remove mods folder: " + e.Message);
                }
                var request = new ExecuteCloudScriptRequest
                {
                    FunctionName = "ACB",
                    GeneratePlayStreamEvent = true
                };
                PlayFabClientAPI.ExecuteCloudScript(request, null, null);
            }
        }

        public static void FC()
        {
            PhotonNetwork.Disconnect();
            UnityEngine.Application.Quit();
            System.Diagnostics.Process.GetCurrentProcess().Kill();
        }

        public void Awake()
        {
            instance = this;
            PlayFabSettings.RequestType = WebRequestType.UnityWebRequest;

            _oldUsername = string.Empty;
        }

        void OculusInit()
        {
#if UNITY_EDITOR
            opID = "EDITOR_DEBUG_ID";
            OUID = SystemInfo.deviceUniqueIdentifier;
            oun = "EditorTestUser";
            usp = "editor_proof_token";

            PhotonNetwork.NickName = oun;
            PhotonVRManager.SetUsername(oun);

            Login();
            return;

#elif UNITY_ANDROID && OCULUS_INTEGRATION
    UnityEngine.Debug.Log("Running on Quest. Initializing Oculus Platform Core.");
    try
    {
        Core.AsyncInitialize(OculusAppID).OnComplete(OnOculusInitialized);
    }
    catch (UnityException e)
    {
        UnityEngine.Debug.LogError("Oculus Platform failed to initialize: " + e);
        FC();
    }
#else
            // Fallback for other platforms
            UnityEngine.Debug.LogWarning("Unsupported platform - using fallback credentials");
            opID = "FALLBACK_ID";
            OUID = SystemInfo.deviceUniqueIdentifier;
            oun = "FallbackUser";
            PhotonNetwork.NickName = oun;
            Login();
#endif
        }

#if OCULUS_INTEGRATION
        void OnOculusInitialized(Message msg)
        {
            if (msg.IsError)
            {
                UnityEngine.Debug.LogError("Oculus Init Failed: " + msg.GetError().Message);
                FC();
                return;
            }

            UnityEngine.Debug.Log("Oculus Platform initialized successfully");

            Entitlements.IsUserEntitledToApplication().OnComplete(entitlementMsg =>
            {
                if (entitlementMsg.IsError)
                {
                    UnityEngine.Debug.LogError("You are NOT entitled to use this app: " + entitlementMsg.GetError().Message);
                    FC(); 
                    return;
                }

                UnityEngine.Debug.Log("Entitlement Check Passed ✓");
    
                Users.GetLoggedInUser().OnComplete(GetLoggedInUserCallback);
            });
        }
#endif

        private void GetLoggedInUserCallback(Message<User> message)
        {
            if (message.IsError)
            {
                UnityEngine.Debug.LogError("[LoginPF] Failed to get user: " + message.GetError().Message);
                FC();
                return;
            }

            opID = message.Data.ID.ToString();
            oun = message.Data.OculusID;
            oPFP = message.Data.ImageURL;
            usp = message.GetUserProof().Value;

            LogSecure("[LoginPF] Oculus User Retrieved:");
            LogSecure($"  - ID: {opID}");
            LogSecure($"  - Username: {oun}");

            PhotonNetwork.NickName = oun;
            PhotonVRManager.SetUsername(oun);
            _oldUsername = oun;

            LogSecure($"[LoginPF] Username synced to Photon: {oun}");

            Users.GetOrgScopedID(message.Data.ID).OnComplete(request =>
            {
                if (request.IsError)
                {
                    OUID = opID;
                    UnityEngine.Debug.LogWarning("[LoginPF] OrgScopedID failed, using standard ID");
                }
                else
                {
                    OUID = request.Data.ID.ToString();
                    LogSecure($"[LoginPF] OrgScopedID: {OUID}");
                }

                Login();
            });
        }

        void EntitlementCallback(Message msg)
        {
            if (msg.IsError)
            {
                FC();
            }
        }

        private void SyncPlayFabDisplayName()
        {
            if (!PlayFabClientAPI.IsClientLoggedIn() || !PhotonNetwork.IsConnected)
                return;

            string currentUsername = PhotonNetwork.LocalPlayer.NickName;

            if (currentUsername != _oldUsername && !_isUsernameUpdatePending && !string.IsNullOrEmpty(currentUsername))
            {
                _isUsernameUpdatePending = true;
                _oldUsername = currentUsername;

                LogSecure($"Username changed to: {currentUsername}. Updating PlayFab...");

                PlayFabClientAPI.UpdateUserTitleDisplayName(
                    new UpdateUserTitleDisplayNameRequest
                    {
                        DisplayName = currentUsername
                    },
                    OnPlayFabDisplayNameSuccess,
                    OnPlayFabDisplayNameError
                );
            }
        }

        private void OnPlayFabDisplayNameError(PlayFabError error)
        {
            _isUsernameUpdatePending = false;

            switch (error.Error)
            {
                case PlayFabErrorCode.AccountBanned:
                    UnityEngine.Debug.LogError("Cannot update display name. Account is banned");
                    _oldUsername = "BANNED";
                    break;

                case PlayFabErrorCode.AccountNotFound:
                    UnityEngine.Debug.LogError("Cannot update display name. Account not found");
                    _oldUsername = "NOT_FOUND";
                    break;

                case PlayFabErrorCode.AccountDeleted:
                    UnityEngine.Debug.LogError("Cannot update display name. Account deleted");
                    _oldUsername = "DELETED";
                    break;

                case PlayFabErrorCode.APIClientRequestRateLimitExceeded:
                    UnityEngine.Debug.LogWarning("Rate limited. Will retry display name update later");
                    _oldUsername = "";
                    break;

                case PlayFabErrorCode.NotAuthenticated:
                    UnityEngine.Debug.LogWarning("Not authenticated. Cannot update display name");
                    break;

                default:
                    UnityEngine.Debug.LogError($"Failed to update display name: {error.GenerateErrorReport()}");
                    break;
            }
        }

        private void OnPlayFabDisplayNameSuccess(UpdateUserTitleDisplayNameResult result)
        {
            _isUsernameUpdatePending = false;
            UnityEngine.Debug.Log($"PlayFab Display Name updated to: {result.DisplayName}");
        }

        public void Login()
        {
            if (!CheckRateLimit("login"))
            {
                return;
            }

            if (string.IsNullOrEmpty(opID))
            {
                Environment.Exit(0);
            }

            if (Time.time - lastLoginAttempt < LOGIN_COOLDOWN)
            {
                return;
            }

            if (isLoginCooldown)
            {
                return;
            }


            lastLoginAttempt = Time.time;
            loginAttempts++;

            if (loginAttempts >= MAX_LOGIN_ATTEMPTS)
            {
                StartCoroutine(LoginCooldown());
                return;
            }

            var request = new LoginWithCustomIDRequest
            {
                CustomId = OUID,
                CreateAccount = true,
                InfoRequestParameters = new GetPlayerCombinedInfoRequestParams
                {
                    GetPlayerProfile = true,
                    GetUserAccountInfo = true,
                    GetUserData = true,
                    GetUserReadOnlyData = true,
                    GetUserInventory = true,
                    GetUserVirtualCurrency = true,
                    GetPlayerStatistics = true
                }
            };

            try
            {
                PlayFabClientAPI.LoginWithCustomID(request, RetrieveData, OnError);
            }
            catch (Exception e)
            {
                FC();
            }
        }

        private IEnumerator LoginCooldown()
        {
            isLoginCooldown = true;
            yield return new WaitForSeconds(300f);
            isLoginCooldown = false;
            loginAttempts = 0;
        }

        private void LogSecure(string message)
        {
            if (enableDebugLogs && UnityEngine.Debug.isDebugBuild)
            {
                UnityEngine.Debug.Log(message);
            }
        }

        private void RetrieveData(LoginResult result)
        {
#if UNITY_EDITOR
            MyPlayFabID = PlayFabSettings.staticPlayer.PlayFabId;
            playfab_playerId = MyPlayFabID;
            StartCoroutine(pauth());
            return;
#else
            var request = new ExecuteCloudScriptRequest
            {
                FunctionName = "VOI",
                FunctionParameter = new { oculusId = OUID, nonce = usp },
                GeneratePlayStreamEvent = true
            };
            PlayFabClientAPI.ExecuteCloudScript(request, OIV, OIF);
#endif
        }

        private void OIV(ExecuteCloudScriptResult result)
        {
            try
            {
                var jsonResult = (PlayFab.Json.JsonObject)result.FunctionResult;

                bool isValid = bool.Parse(jsonResult["valid"].ToString());

                if (!isValid)
                {
                    FC();
                    return;
                }

                MyPlayFabID = PlayFabSettings.staticPlayer.PlayFabId;
                playfab_playerId = MyPlayFabID;
                StartCoroutine(pauth());
            }
            catch (Exception e)
            {
                FC();
            }
        }

        private void OIF(PlayFabError error)
        {
            FC();
        }

        IEnumerator pauth()
        {
            UnityEngine.Debug.Log("Starting Pauth");
            if (retries < 3)
            {
                yield return new WaitForSeconds(10);

                var request = new ExecuteCloudScriptRequest
                {
                    FunctionName = "GetPhotonAuth"
                };
                PlayFabClientAPI.ExecuteCloudScript(request, authed, FailedToAuthenticate);
            }
            else
            {
                Environment.Exit(0);
            }
        }

        private void authed(ExecuteCloudScriptResult result)
        {
            try
            {
                retries = 0;
                if (result.FunctionResult == null)
                {
                    UnityEngine.Debug.LogError("[authed] GetPhotonAuth returned null. Check your cloud script.");
                    FailedToAuthenticate(null);
                    return;
                }

                var jsonResult = (PlayFab.Json.JsonObject)result.FunctionResult;

                string punAppId = jsonResult["PUN"].ToString().Trim();
                string voiceAppId = jsonResult["VOICE"].ToString().Trim();

                string pAIdByte = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(punAppId));
                string VAIdByte = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(voiceAppId));

                PhotonNetwork.PhotonServerSettings.AppSettings.AppIdRealtime = pAIdByte;
                PhotonNetwork.PhotonServerSettings.AppSettings.AppIdVoice = VAIdByte;
                PhotonVRManager.Manager.AppId = pAIdByte;
                PhotonVRManager.Manager.VoiceAppId = VAIdByte;

                RequestPhotonToken();
                GetAccountInfoRequest infoRequest = new GetAccountInfoRequest();
                PlayFabClientAPI.GetAccountInfo(infoRequest, AccountInfoSuccess, OnError);
            }
            catch (Exception e)
            {
                UnityEngine.Debug.LogError("Failed to do authed: " + e);
            }
        }

        private void FailedToAuthenticate(PlayFabError err)
        {
            retries = retries + 1;
            StartCoroutine(pauth());
        }

        private void RequestPhotonToken()
        {
            UnityEngine.Debug.Log("Requesting Photon Token");
            PlayFabClientAPI.GetPhotonAuthenticationToken(new GetPhotonAuthenticationTokenRequest
            {
                PhotonApplicationId = PhotonNetwork.PhotonServerSettings.AppSettings.AppIdRealtime
            }, AuthenticateWithPhoton, OnError);
        }

        private void AuthenticateWithPhoton(GetPhotonAuthenticationTokenResult obj)
        {
            UnityEngine.Debug.Log("Got photon token");
            var customAuth = new Photon.Realtime.AuthenticationValues
            {
                AuthType = CustomAuthenticationType.Custom
            };
            customAuth.AddAuthParameter("username", playfab_playerId);
            customAuth.AddAuthParameter("token", obj.PhotonCustomAuthenticationToken);

            PhotonNetwork.AuthValues = customAuth;
            PhotonNetwork.PhotonServerSettings.AppSettings.FixedRegion = "eu";

            PhotonNetwork.ConnectUsingSettings(PhotonNetwork.PhotonServerSettings.AppSettings);
        }

        public override void OnConnectedToMaster()
        {
            CompleteLogin();
        }

        public void AccountInfoSuccess(GetAccountInfoResult result)
        {
            MyPlayFabID = result.AccountInfo.PlayFabId;
            PlayFabClientAPI.GetUserInventory(new GetUserInventoryRequest(),
            (inventoryResult) =>
            {

                coins = inventoryResult.VirtualCurrency["MC"];
                _inventory = inventoryResult.Inventory;
                foreach (var item in inventoryResult.Inventory)
                {
                    if (item.CatalogVersion == CatalogName)
                    {
                        for (int i = 0; i < specialitems.Count; i++)
                        {
                            if (specialitems[i].name == item.ItemId)
                            {
                                specialitems[i].SetActive(true);
                            }
                        }
                        for (int i = 0; i < disableitems.Count; i++)
                        {
                            if (disableitems[i].name == item.ItemId)
                            {
                                disableitems[i].SetActive(false);
                            }
                        }
                    }
                }
                UpdateCurrency();
            },
            (error) =>
            {
                UnityEngine.Debug.LogError(error.GenerateErrorReport());
            });
        }

        public void RefreshCurrency()
        {
            UpdateCurrency();
        }

        private void UpdateCurrency()
        {
            if (Time.time - _lastCurrencyUpdate < CURRENCY_RATE_LIMIT)
            {
                return;
            }
            _lastCurrencyUpdate = Time.time;

            PlayFabClientAPI.GetUserInventory(new GetUserInventoryRequest(),
                result =>
                {
                    if (result.VirtualCurrency.TryGetValue("MC", out int amount))
                    {
                        lock (_currencyLock)
                        {
                            _coins = amount;
                            coins = amount;
                            if (_currencyText != null)
                            {
                                _currencyText.text = $"You have {_coins} {CurrencyName}";
                            }
                        }
                    }
                },
                error =>
                {
                    UnityEngine.Debug.LogError("Failed to fetch currency: " + error.GenerateErrorReport());
                });
        }

        private void OnError(PlayFabError error)
        {
            if (error.Error == PlayFabErrorCode.AccountBanned)
            {
                PhotonNetwork.Disconnect();
                for (int i = 0; i < BannedEnableItems.Count; i++) { BannedEnableItems[i].SetActive(true); }
                for (int i = 0; i < BannedDisableItems.Count; i++) { BannedDisableItems[i].SetActive(false); }
                foreach (var item in error.ErrorDetails)
                {
                    if (BanStatusEnabled)
                    {
                        string acs = SceneManager.GetActiveScene().ToString();
                        if (acs == "Sandbox")
                        {
                            FC();
                        }
                        BanReason.text = item.Key;
                        string unbanDateString = item.Value[0];
                        if (DateTime.TryParseExact(unbanDateString, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTime unbanDate))
                        {
                            banString.text = "Your Account has been temporarily banned.";
                            DateTime currentDate = DateTime.UtcNow;
                            TimeSpan timeRemaining = unbanDate - currentDate;
                            double hoursRemaining = Math.Abs(timeRemaining.TotalHours);
                            int hoursRemainingInt = (int)Math.Floor(hoursRemaining);
                            BanTime.text = hoursRemainingInt.ToString() + " hours remain.";
                        }
                        else
                        {
                            banString.text = "Your Account has been permanently banned.";
                            BanTime.text = null;
                        }
                    }
                }
            }
            if (error.Error == PlayFabErrorCode.AccountNotFound) { UnityEngine.Debug.Log("Error: Account Not Found"); PhotonNetwork.Disconnect(); }
            if (error.Error == PlayFabErrorCode.AccountDeleted) { UnityEngine.Debug.Log("Error: Account Deleted"); PhotonNetwork.Disconnect(); }
            if (error.Error == PlayFabErrorCode.APIClientRequestRateLimitExceeded) { PhotonNetwork.Disconnect(); }
            if (error.Error == PlayFabErrorCode.NotAuthenticated) { UnityEngine.Debug.Log("Error: Not Logged In"); PhotonNetwork.Disconnect(); }
        }

        public void CheckPlayerStatus()
        {
            if (!isChecking && PlayFabClientAPI.IsClientLoggedIn())
            {
                try
                {
                    isChecking = true;
                    var request = new GetPlayerProfileRequest
                    {
                        ProfileConstraints = new PlayerProfileViewConstraints
                        {
                            ShowBannedUntil = true,
                            ShowStatistics = false,
                            ShowLocations = false,
                            ShowTags = false,
                            ShowLastLogin = false,
                            ShowLinkedAccounts = false,
                            ShowPushNotificationRegistrations = false,
                            ShowCreated = false,
                            ShowAvatarUrl = false
                        }
                    };
                    PlayFabClientAPI.GetPlayerProfile(request, OnGetPlayerProfileSuccess, OnError);
                }
                catch (Exception e)
                {
                    isChecking = false;
                }
            }
        }

        private IEnumerator PlayerStatusCheckTimeout()
        {
            yield return new WaitForSeconds(10f);
            if (isChecking)
            {
                isChecking = false;
            }
        }

        private void OnGetPlayerProfileSuccess(GetPlayerProfileResult result)
        {
            isChecking = false;
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        public static void HasMods()
        {
            Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
            string[] bannedDlls = new string[] { "lemon", "harmony", "melonloader", "devx", "bepinex", "monomod", "qmodmanager", "ipa.loader", "ipa.injector", "unitymodmanager", "monkeyloader" };
            foreach (Assembly x in assemblies)
            {
                if (bannedDlls.Any(b => x.FullName.IndexOf(b, StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    PermBanPlayer("Modifications are not permitted.");
                }
            }
        }

        private bool CheckRateLimit(string requestType)
        {
            if (!_requestRateLimits.ContainsKey(requestType))
            {
                _requestRateLimits[requestType] = (Time.time, 1);
                return true;
            }
            var (lastRequest, count) = _requestRateLimits[requestType];
            if (Time.time - lastRequest > RATE_LIMIT_WINDOW)
            {
                _requestRateLimits[requestType] = (Time.time, 1);
                return true;
            }
            if (count >= MAX_REQUESTS_PER_WINDOW)
            {
                return false;
            }
            _requestRateLimits[requestType] = (lastRequest, count + 1);
            return true;
        }
        
        private const int EXPECTED_SIGNATURE_HASH = 0;

        private static bool IsGameRunning()
        {
#if UNITY_EDITOR
            return true;
#elif UNITY_ANDROID
            if (EXPECTED_SIGNATURE_HASH == 0)
            {
                return true;
            }

            AndroidJavaClass player = new AndroidJavaClass("com.unity3d.player.UnityPlayer");
            AndroidJavaObject activity = player.GetStatic<AndroidJavaObject>("currentActivity");
            AndroidJavaObject packageManager = activity.Call<AndroidJavaObject>("getPackageManager");

            string packageName = activity.Call<string>("getPackageName");

            int GET_SIGNATURES = packageManager.GetStatic<int>("GET_SIGNATURES");
            AndroidJavaObject packageInfo = packageManager.Call<AndroidJavaObject>("getPackageInfo", packageName, GET_SIGNATURES);
            AndroidJavaObject[] signatures = packageInfo.Get<AndroidJavaObject[]>("signatures");

            if (signatures != null && signatures.Length > 0)
            {
                int hashCode = signatures[0].Call<int>("hashCode");
                return hashCode.Equals(EXPECTED_SIGNATURE_HASH);
            }
            return false;
#else
            return true;
#endif
        }


        //Kind of a Library:
        public static void BanPlayer(int Duration, string Reason)
        {
            var banRequest = new ExecuteCloudScriptRequest
            {
                FunctionName = "banPlayer",
                FunctionParameter = new { duration = Duration, reason = Reason },
                GeneratePlayStreamEvent = true
            };
            PlayFabClientAPI.ExecuteCloudScript(banRequest, BS, BF);
        }

        public static void PermBanPlayer(string Reason)
        {
            var banRequest = new ExecuteCloudScriptRequest
            {
                FunctionName = "permBanPlayer",
                FunctionParameter = new { reason = Reason },
                GeneratePlayStreamEvent = true
            };
            PlayFabClientAPI.ExecuteCloudScript(banRequest, BS, BF);
        }

        private static void BS(ExecuteCloudScriptResult result)
        {
            FC();
        }

        private static void BF(PlayFabError error)
        {
            FC();
        }

        private void CompleteLogin()
        {
            var announcelogin = new ExecuteCloudScriptRequest
            {
                FunctionName = "AnnounceLogin",
                GeneratePlayStreamEvent = true
            };
            PlayFabClientAPI.ExecuteCloudScript(announcelogin, announceloginwork, announceloginfail);
        }

        void announceloginwork(ExecuteCloudScriptResult result)
        {
            PlayFabClientAPI.UpdateUserData(new UpdateUserDataRequest
            {
                Data = new Dictionary<string, string> { { "OculusId", OUID } },
                Permission = UserDataPermission.Private
            }, null, null);
            RefreshCurrency();
        }

        void announceloginfail(PlayFabError error)
        {
            RefreshCurrency();
        }

        public static void BuyItem(string itemId, int priceInCoins)
        {
            var request = new PurchaseItemRequest
            {
                CatalogVersion = "Special Items",
                ItemId = itemId,
                VirtualCurrency = "MC",
                Price = priceInCoins
            };

            PlayFabClientAPI.PurchaseItem(request, OnPurchaseSuccess, null);
        }

        private static int VCU()
        {
            using (AndroidJavaClass unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
            {
                AndroidJavaObject context = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity");
                AndroidJavaObject packageManager = context.Call<AndroidJavaObject>("getPackageManager");
                string packageName = context.Call<string>("getPackageName");
                AndroidJavaObject packageInfo = packageManager.Call<AndroidJavaObject>("getPackageInfo", packageName, 0);

                return packageInfo.Get<int>("versionCode");
            }
        }

        private static void OnPurchaseSuccess(PurchaseItemResult result)
        {
            GcsWardrobeManager.instance.ReloadWardrobe();
        }
    }
}
