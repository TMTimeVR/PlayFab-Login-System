# PlayFab-Login-System
A login system for VR games made for a Oculus Quest.

# Dependencies

- [The PlayFab Unity SDK](https://github.com/PlayFab/UnitySDK) [(Download)](https://aka.ms/PlayFabUnitySdk)
- [Photon VR (I used my forked version of it but I don't think it will be necessary to use it)](https://github.com/fchb1239/PhotonVR) [Forked version](https://github.com/TMTimeVR/PhotonVR)
- [The Meta XR All-in-One SDK](https://assetstore.unity.com/packages/tools/integration/meta-xr-all-in-one-sdk-269657)
- TextMeshPro
- [Glitched Cat Studios's Wardrobe System](https://github.com/Glitched-Cat-Studios/GCS-Wardrobe)

# DISCLAIMER:

**Yes, AI was used in this system.**
I have absolutely no idea if this is a safe and secure way to do authentication. This is an older version of the backend of [Monkey Mall](https://www.meta.com/en-gb/experiences/chimpstitute/6878051502218331/).

# Credits:

I used large code snippets of SolarisDev09's [AdvancedPlayFab](https://github.com/SolarisDev09/AdvancedPlayfab?tab=readme-ov-file) and JokerJosh0's [EasyPlayFab](https://github.com/JokerJosh0/EasyPlayfab).
I also used [some random PlayFab login script from 2023](https://github.com/TMTimeVR/PlayFab-Login-System/blob/main/SomeRandomPlayFabLoginScriptFrom2023.cs). I think it was made by someone called "MONKI".

The APK hash verification code snippet (line 1043 - 1068) was made by ![MaxNiftyNine](https://github.com/MaxNiftyNine). ![This guide was used](https://github.com/TMTimeVR/PlayFab-Login-System/raw/refs/heads/main/guide/How%20to%20add%20anticheat%20to%20your%20gorilla%20tag%20fan%20game%20(stop%20moddinghacking).mp4).

# Setup:

1. Import the PhotonVR, Photon PUN, GCS Wardrobe System, Photon Voice and the PlayFab Unity package. You might get prompted to import the TextMeshPro package. Please import it.

2. Go to your PlayFab title and click on "Settings" and then "API Features":
   ![](https://github.com/TMTimeVR/PlayFab-Login-System/blob/main/guide/enable%20settings.png?raw=true)

   Enable all of this:

   ![](https://github.com/TMTimeVR/PlayFab-Login-System/blob/main/guide/APIFeatures.png?raw=true)

4. At the top of your window, click "PlayFab" and then "MakePlayFabSharedSettings".
   ![](https://github.com/TMTimeVR/PlayFab-Login-System/blob/main/guide/AddTitleID.png?raw=true)

5. Follow the [GCS Wardrobe setup guide](https://github.com/TMTimeVR/PlayFab-Login-System/raw/refs/heads/main/guide/GCSWARDROBETUTORIAL.mp4) (Made by The Tech Wizard (I think)).

6. Go to line 824 - 849 and follow ![MaxNiftyNine's tutorial](https://github.com/TMTimeVR/PlayFab-Login-System/raw/refs/heads/main/guide/How%20to%20add%20anticheat%20to%20your%20gorilla%20tag%20fan%20game%20(stop%20moddinghacking).mp4).
