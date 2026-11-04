# 📡 Radar Boursier

Mon radar d'investissement personnel : occasions classées, portefeuille Wealthsimple, dividendes réinvestis, grands investisseurs, alertes de prix.
Il fonctionne **gratuitement, sans Claude** :

- **La page** (`index.html`) est publiée par GitHub Pages et s'ouvre dans n'importe quel navigateur, sur ordinateur ou téléphone.
- **Les données** sont mises à jour chaque jour ouvrable vers 17 h 20 (heure de Montréal) par GitHub Actions (`.github/workflows/update.yml`), avec Yahoo Finance (prix, historique 5 ans, ratios, dividendes, fractionnements, états financiers, nouvelles) et la SEC (déclarations 13F des grands investisseurs, le lundi).
- **Mes données personnelles** (positions, transactions, dividendes, alertes) sont dans `data/private.enc.json`, chiffrées en AES-256-GCM. Sans le mot de passe, ce fichier est illisible, même si le dépôt est public.

## Fichiers

| Fichier | Rôle | Qui l'écrit |
|---|---|---|
| `data/universe.json` | Titres suivis, scores de mon fichier Excel, analyses écrites par Claude | La page (ajout ou retrait d'un titre) |
| `data/market.json` | Prix, historique, ratios, dividendes, états financiers | GitHub Actions |
| `data/investors.json` | Portefeuilles des grands investisseurs | GitHub Actions (lundi) |
| `data/private.enc.json` | Positions, transactions, dividendes réinvestis, fractionnements, alertes (chiffré) | La page et GitHub Actions |

## Réglages une fois pour toutes

1. **Pages** : Settings → Pages → Source « Deploy from a branch » → `main` / `(root)` → Save.
2. **Secret** : Settings → Secrets and variables → Actions → New repository secret → nom `RADAR_PASSWORD`, valeur = le mot de passe du coffre. Sans ce secret, les prix se mettent à jour, mais les dividendes et fractionnements ne sont pas appliqués à mes positions.
3. **Jeton pour enregistrer depuis la page** (facultatif) : créer un jeton « fine-grained » limité à ce dépôt avec *Contents : Read and write* et *Actions : Read and write*, puis le coller dans ⚙️ Réglages sur la page. Il reste seulement sur l'appareil.

## Lancer une mise à jour à la main

Onglet **Actions** → « Mise à jour du Radar » → **Run workflow** (ou le bouton « Mettre à jour maintenant » dans ⚙️ Réglages).

> Outil d'aide à la réflexion, pas un conseil financier.
