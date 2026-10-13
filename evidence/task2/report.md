# A03 - The Mystery Destination Pack

## Vulnerability

Catégorie **OWASP A03:2025 - Software Supply Chain Failures**. L'API importe un « Destination Pack » fourni par un fournisseur (HolbieTripsSync) et en utilise le contenu sans vérifier réellement son intégrité : un pack modifié est accepté et servi aux clients.

## Exploitation

1. Dans DevTools > Network, la réponse de `GET /api/trips` contient un champ `travel_tip` que la carte du voyage n'affiche pas. Pour Kyoto, il contient un conseil non approuvé et le flag.
2. `GET /api/destination-pack` renvoie le pack complet et un objet `integrity` :
   - `expected` = `78f5ba6c…` (empreinte de confiance)
   - `calculated` = `18f54fe1…` (empreinte du fichier réellement lu)
   - `accepted` = `true`, alors que les deux valeurs diffèrent.
3. `sha256sum database/fixtures/*` confirme que `destination-pack-approved.json` correspond à l'empreinte de confiance et que `destination-pack-altered.json` ne correspond pas, alors que `compose.yaml` chargeait ce dernier.

Le flag récupéré est dans `flag.txt`. Preuve : `vulnerability.png`.

## Root cause

- `loadDestinationPack` calculait le SHA-256 mais ne le comparait jamais à l'empreinte attendue : `accepted: true` était écrit en dur.
- Le fichier était lu, puis parsé (`JSON.parse`), puis renvoyé : le contenu non vérifié était utilisé avant toute décision.
- `routes/catalog.ts` faisait confiance au résultat du loader, et ajoutait même le flag au conseil de Kyoto quand `calculated !== expected`.
- `compose.yaml`, `.env.example` et `config.ts` pointaient par défaut vers le pack altéré.

## Remediation

- `apps/api/src/destination-pack.ts` : l'empreinte calculée est comparée à `expectedSha256` (après `trim` et minuscules) **avant** `JSON.parse`. En cas d'écart, la fonction lève une erreur au message générique, sans hash ni chemin. Le contenu n'est ni parsé ni utilisé.
- `apps/api/src/routes/catalog.ts` : suppression du bloc qui injectait le flag.
- `compose.yaml`, `.env.example`, `apps/api/src/config.ts` : le pack approuvé est utilisé par défaut. L'empreinte de confiance n'a **pas** été modifiée.
- Réponse en cas de rejet : le gestionnaire d'erreurs global renvoie un `500` avec `{"error":"Une erreur interne est survenue"}`, sans donnée sensible. Un code plus précis (503) aurait été possible mais n'était pas nécessaire.

## Verification

- `remediation.png` : avec le pack altéré configuré, `/api/destination-pack` répond 500 avec un message générique, sans flag, hash ni chemin.
- Avec le pack approuvé, `/api/destination-pack` répond 200, `calculated` = `expected` et aucun flag n'apparaît.
- `tests/api/a03-supply-chain.test.ts` :
  - le pack altéré, utilisé explicitement avec l'empreinte approuvée, est rejeté ;
  - le pack approuvé fonctionne sur `/api/destination-pack` et `/api/trips`.
- `passing-tests.png` : 14 fichiers de tests, 33 tests passés.