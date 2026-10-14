# A04 – Passport Panic (Cryptographic Failures)

## 1. Faille

Le numéro de passeport était stocké dans `traveler_profiles.passport_ciphertext`, mais en mode `legacy-base64` il n'était **pas chiffré** : il était simplement encodé en base64. Le marqueur `passport_iv = 'legacy-base64'` indiquait le mode, et `passport_tag` était `NULL`. Dans `security.ts`, les branches `protectPassport` (écriture) et `revealPassport` (lecture) du mode legacy n'utilisaient jamais `APP_ENCRYPTION_KEY`. Quiconque lit une copie de la base peut donc retrouver le passeport sans aucune clé. Le mode legacy était en plus le mode par défaut (`config.ts`, `.env.example`, `compose.yaml`), donc les nouvelles écritures étaient elles aussi mal protégées.

Un nom de colonne comme `ciphertext` ne prouve pas qu'une clé est utilisée : l'encodage change la représentation, le chiffrement exige un secret.

## 2. Preuve (avant correctif)

Profil concerné : Bruno Dupont (`10000000-0000-4000-8000-000000000002`), seul profil avec un passeport (fictif) dans le seed.

```sql
SELECT passport_ciphertext, passport_iv FROM traveler_profiles
WHERE user_id = '10000000-0000-4000-8000-000000000002';
-- RlItREVNTy1CUlVOTy04NzQy | legacy-base64
```

```bash
echo 'RlItREVNTy1CUlVOTy04NzQy' | base64 -d
# FR-DEMO-BRUNO-8742
```

Le passeport est retrouvé sans clé. Envoyé à `POST /api/challenges/a04/claim` depuis une session locale authentifiée, il renvoie le flag :

```
FLAG{a04_41dd00af12c82d0e7c9acaf5}
```

Capture : `vulnerability.png` (aucun token visible). Flag aussi dans `flag.txt`.

## 3. Correctif

| Fichier | Changement |
|---|---|
| `apps/api/src/security.ts` | `protectPassport(value, keyHex)` appelle toujours `encryptSensitive` (AES-256-GCM, IV aléatoire de 12 octets, tag d'authentification). La branche `legacy-base64` de `revealPassport` est supprimée : une ligne sans `iv` ou sans `tag` est refusée. |
| `apps/api/src/routes/profile.ts` | Le paramètre de mode n'est plus passé à `protectPassport`. La route `POST /api/challenges/a04/claim` est supprimée (avec son empreinte de preuve). |
| `apps/api/src/config.ts` | `passportProtectionMode` supprimé. |
| `compose.yaml` | `APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}` (plus de clé en dur), `PASSPORT_PROTECTION_MODE` supprimé. |
| `.env.example` | `APP_ENCRYPTION_KEY=` vide avec le conseil `openssl rand -hex 32`, mode supprimé. |
| `scripts/migrate-legacy-passports.ts` | Script de migration (voir §4). |
| `package.json` | Script `migrate:passports`. |

Aucune cryptographie nouvelle n'a été écrite : on réutilise `encryptSensitive` / `decryptSensitive`, déjà présents dans le dépôt. La clé locale est fournie par l'environnement via un fichier `.env` ignoré par git.

## 4. Migration des anciennes lignes

Changer seulement le mode ne migre pas les enregistrements existants : la ligne de Bruno restait lisible en base64. Le script `scripts/migrate-legacy-passports.ts` sélectionne les lignes `passport_iv = 'legacy-base64'`, décode la valeur, la rechiffre avec `encryptSensitive` et met à jour `passport_ciphertext`, `passport_iv`, `passport_tag`. L'`UPDATE` est conditionné par `passport_iv='legacy-base64'`, donc le script est idempotent : une deuxième exécution migre 0 ligne.

Avant / après pour Bruno :

```
AVANT : passport_iv = legacy-base64   | has_tag = f | ct = RlItREVNTy1C
APRÈS : passport_iv = NoQfhYgnM+Sj2L4j | has_tag = t | ct = H9vhp5XNUZKA
```

Exécution : `Passeports migrés: 1`.

## 5. Vérification

- La requête précédente vers `/api/challenges/a04/claim` avec le passeport récupéré renvoie désormais **404** (« Ressource introuvable »), sans flag. Capture : `remediation.png` (aucun token visible).
- Le profil de Bruno s'affiche toujours avec `FR-DEMO-BRUNO-8742` : la lecture autorisée par l'application fonctionne avec la clé.
- Tests (`tests/api/a04-cryptographic-failures.test.ts`, 5 tests) :
  - stockage authentifié : IV différent de `legacy-base64`, tag présent, aucun clair dans le ciphertext ;
  - falsification rejetée : un octet modifié dans le ciphertext ou dans le tag fait échouer `revealPassport` ;
  - une ligne legacy (`iv='legacy-base64'`, tag `NULL`) est refusée ;
  - l'ancienne preuve envoyée à `/api/challenges/a04/claim` donne un 404 sans flag ;
  - test métier : `PUT /api/me` stocke une valeur chiffrée, `GET /api/me` restitue le passeport en clair.
- Suite complète : 14 fichiers, 36 tests au vert. Capture : `passing-tests.png`.

## 6. Limites

- `config.ts` conserve une valeur de repli pour `APP_ENCRYPTION_KEY`. Si la variable est absente côté application (hors Compose), la clé de démo, publique dans le dépôt, serait utilisée. Une base volée serait alors déchiffrable par quiconque lit le dépôt. Supprimer ce repli est la suite logique (au prix d'adapter la configuration des tests).
- La clé de démo a été publiée dans l'historique git (`.env.example`, `compose.yaml`). Elle doit être considérée comme compromise : en production, il faudrait en générer une nouvelle, la rechiffrer et la stocker dans un gestionnaire de secrets.
- Aucune rotation de clé n'est prévue : le format stocké ne contient pas d'identifiant de version de clé.
- Seul le passeport est concerné par ce correctif ; les autres champs du profil (téléphone, date de naissance) restent en clair, ce qui n'était pas dans le périmètre du défi.
- Le script de migration a été exécuté une fois sur la base de démo locale ; en cas d'échec au milieu d'un lot, il peut être relancé sans risque.