// Phase 4 unblock: PlayFab BuyItem chain removed. Goes through Nakama's
// inventory_purchase RPC (server validates expectedCost against system:
// catalog and grants the item idempotently).
using UnityEngine;
using PlayFab.login;
using MonkeyMall.Authentication;

public class WardrobePurchase : MonoBehaviour
{
    [Header("BUY")]
    [SerializeField] private string _itemID;
    [SerializeField] private int _coinsPrice;

    private void OnTriggerEnter(Collider other)
    {
        if (other.name == "RightHand Controller" || other.name == "LeftHand Controller")
        {
            if (Playfablogin.instance != null && Playfablogin.instance.coins >= _coinsPrice)
            {
                BuyAsync();
            }
        }
    }

    private async void BuyAsync()
    {
        if (NakamaClient.Instance == null || !NakamaClient.Instance.IsLoggedIn) return;
        try
        {
            var resp = await NakamaClient.Instance.Purchase(_itemID, _coinsPrice);
            if (resp != null && (resp.success || resp.alreadyOwned))
            {
                if (Playfablogin.instance != null) Playfablogin.instance.RefreshCurrency();
            }
        }
        catch (System.Exception e)
        {
            Debug.LogError("[WardrobePurchase] inventory_purchase failed: " + e.Message);
        }
    }
}
