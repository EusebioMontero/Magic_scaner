#!/usr/bin/env python3
"""Genera names.json, el diccionario local de nombres de carta.

- Inglés: catálogo oficial de Scryfall (/catalog/card-names).
- Español: nombres impresos de todas las impresiones lang:es (búsqueda paginada).

Uso:  python build_names.py [salida.json]
Solo usa la biblioteca estándar. Tarda un par de minutos.
"""
import datetime
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.scryfall.com"
HEADERS = {"User-Agent": "Magic_scaner-names-builder/0.1", "Accept": "application/json"}
PAUSE = 0.12  # Scryfall pide entre 50 y 100 ms entre peticiones


def get(url, retries=4):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            if attempt < retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            raise


def printed_name(card):
    """Nombre impreso de la carta; en las de dos caras, las caras unidas con ' // '."""
    name = card.get("printed_name")
    if name:
        return name
    faces = [f.get("printed_name") for f in card.get("card_faces", [])]
    faces = [f for f in faces if f]
    return " // ".join(faces) if faces else None


def build_dictionary(en_names, es_cards):
    """Función pura: construye el diccionario a partir de los datos de Scryfall."""
    names = set(en_names)
    pairs = set()
    for card in es_cards:
        if card.get("lang") != "es":
            continue
        es, en = printed_name(card), card.get("name")
        if not es or not en:
            continue
        names.add(en)
        es = es.strip()
        if es.casefold() == en.strip().casefold():
            continue  # igual que el inglés: ya lo cubre el nombre inglés
        pairs.add((es, en))
    names = sorted(names)
    index = {n: i for i, n in enumerate(names)}
    es_list = sorted(([e, index[n]] for e, n in pairs), key=lambda p: (p[1], p[0]))
    return {"v": 1, "names": names, "es": es_list}


def fetch_spanish():
    query = urllib.parse.urlencode(
        {"q": "lang:es", "unique": "prints", "include_multilingual": "true"}
    )
    url = f"{API}/cards/search?{query}"
    cards, page = [], 0
    while url:
        data = get(url)
        page += 1
        for c in data["data"]:
            cards.append(
                {
                    "lang": c.get("lang"),
                    "name": c.get("name"),
                    "printed_name": c.get("printed_name"),
                    "card_faces": [
                        {"printed_name": f.get("printed_name")}
                        for f in c.get("card_faces", [])
                    ],
                }
            )
        print(f"  página {page}: {len(cards)} impresiones", file=sys.stderr)
        url = data.get("next_page") if data.get("has_more") else None
        time.sleep(PAUSE)
    return cards


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "names.json"
    print("Nombres en inglés…", file=sys.stderr)
    en_names = get(f"{API}/catalog/card-names")["data"]
    time.sleep(PAUSE)
    print("Nombres en español…", file=sys.stderr)
    es_cards = fetch_spanish()
    d = build_dictionary(en_names, es_cards)
    d["date"] = datetime.date.today().isoformat()
    with open(out, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    print(
        f"{out}: {len(d['names'])} nombres, {len(d['es'])} nombres en español",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
