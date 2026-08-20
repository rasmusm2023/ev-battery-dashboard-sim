import os
import requests

FALLBACK_CHARGERS = [
    "Göteborg Centralstation (Göteborg)",
    "Lindholmen Science Park (Göteborg)",
    "Nordstan P-hus (Göteborg)",
]


def get_nearby_chargers(lat, lon):
    # Anropar Open Charge Map API för position nära Göteborg/Sverige
    # Kräver API-nyckel: sätt OPENCHARGEMAP_API_KEY i miljön för live-data
    url = (
        f"https://api.openchargemap.io/v3/poi/?output=json"
        f"&latitude={lat}&longitude={lon}&maxresults=3&compact=true&verbose=false"
    )

    headers = {
        "User-Agent": "MobilityDemoApp",
    }

    api_key = os.environ.get("OPENCHARGEMAP_API_KEY")
    if api_key:
        headers["X-API-Key"] = api_key
        url += f"&key={api_key}"

    try:
        response = requests.get(url, headers=headers, timeout=8)
        if response.status_code == 200:
            data = response.json()
            chargers = []
            for item in data:
                title = item.get("AddressInfo", {}).get("Title", "Okänd laddare")
                town = item.get("AddressInfo", {}).get("Town", "")
                chargers.append(f"{title} ({town})" if town else title)
            return chargers or FALLBACK_CHARGERS
    except requests.RequestException:
        pass

    return FALLBACK_CHARGERS


# Testkör för Göteborgs-koordinater
