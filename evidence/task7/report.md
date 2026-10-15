# A08 - Software and Data Integrity Failures (« Payment Postcard Pretender »)

**Référence OWASP Top 10:2025** — A08 : Software and/or Data Integrity Failures
**Projet** — HolbieTrips (Fastify + PostgreSQL)
**Route concernée** — `POST /api/payments/callback`
**Fichier corrigé** — `apps/api/src/routes/payments.ts`
**Tests** — `tests/api/a08-integrity-failures.test.ts`
**Flag** — `FLAG{a08_5e07fef869a8cbb944642747}`

---

## 1. Contexte

HolbieTrips confirme un paiement par deux chemins distincts qui écrivent dans les mêmes tables (`bookings`, `payments`) :

- Le **checkout client** `POST /api/bookings/:id/pay` : il exige un utilisateur authentifié, appelle le simulateur de paiement interne, puis **vérifie une signature HMAC** (`validSignature`) sur la réponse avant de confirmer la réservation.
- Le **callback prestataire** `POST /api/payments/callback` : entrée censée recevoir la notification d'un prestataire de paiement. Il met à jour les mêmes tables mais **ne vérifiait aucune signature**.

La confiance du système reposait donc sur un contrôle d'intégrité (HMAC) présent d'un côté et absent de l'autre.

## 2. Vulnérabilité

Le handler du callback ne validait que la **cohérence** des champs (UUID valide, montant entier, `status === 'approved'`, référence ≥ 5 caractères, 4 chiffres de carte) puis la correspondance avec une réservation `pending` au bon montant. Aucune de ces vérifications ne prouve **qui** a envoyé le message.

> Un identifiant de réservation et le bon montant prouvent que les champs concordent, pas l'origine du message. Seule une signature HMAC calculée avec la clé partagée entre services authentifie l'émetteur et garantit l'intégrité du contenu.

N'importe quel appelant connaissant le format JSON attendu — lisible directement dans le code du handler — pouvait donc déclarer une réservation « payée ».

## 3. Exploitation

Les valeurs de la réservation de démonstration (Bruno Dupont, statut `pending`) sont lues dans le seed de la base :

- `bookingId` : `40000000-0000-4000-8000-000000000002`
- `amountCents` : `129900`

Depuis la console du navigateur (même origine que l'API, `http://127.0.0.1:8080`), une requête **non signée** suffit :

```javascript
fetch('/api/payments/callback', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    bookingId: '40000000-0000-4000-8000-000000000002',
    amountCents: 129900,
    status: 'approved',
    providerReference: 'DEMO-REF-12345',
    cardLast4: '4242'
  })
}).then(r => r.json()).then(console.log);
```

Réponse de l'API :

```json
{ "status": "confirmed", "flag": "FLAG{a08_5e07fef869a8cbb944642747}" }
```

La réservation de Bruno est confirmée et une ligne `payments` est créée, sans qu'aucun paiement authentifié n'ait eu lieu (voir `vulnerability.png`).

## 4. Impact

- **Intégrité** : une réservation bascule de `pending` à `confirmed` sans paiement réel vérifié.
- **Fraude** : un attaquant confirme ses propres réservations gratuitement.
- **Rejeu** : l'ancien `ON CONFLICT(booking_id) DO UPDATE` et l'`UPDATE` sans condition de statut permettaient de réappliquer une même notification.

## 5. Correctif

Correctif appliqué au seul handler `/api/payments/callback` (le checkout `/pay` est inchangé). Trois mesures :

1. **Vérification de signature** : réutilisation de `validSignature()` (déjà utilisée par le checkout) sur un payload **canonique** : exactement les mêmes champs, dans le même ordre que `signedFields` du checkout (`bookingId, amountCents, status, providerReference, cardLast4`), car `paymentSignature` calcule le HMAC sur `JSON.stringify(payload)` — l'ordre des clés est significatif. Signature absente ou invalide → **401**.

2. **Anti-rejeu** : l'`UPDATE` ne confirme que si la réservation est encore `pending` (`WHERE id=$1 AND status='pending'`) et le `rowCount` est contrôlé dans la transaction. Une réservation déjà confirmée → **409**, état préservé.

3. **Idempotence du paiement** : passage de `ON CONFLICT(booking_id) DO UPDATE` à `DO NOTHING` : un rejeu ne réécrit pas la ligne `payments`.

Les contrôles métier d'origine (montant = `total_cents`, `status === 'approved'`, réservation `pending`) sont conservés.

## 6. Vérification

- **Rejet post-correctif** : la même requête non signée renvoie désormais `401 Unauthorized` — `{ "error": "Signature de paiement invalide" }` (voir `remediation.png`).
- **Tests** : `tests/api/a08-integrity-failures.test.ts` couvre 5 cas :
  - callback correctement **signé** → 200, réservation confirmée, flag présent (test métier positif) ;
  - callback **non signé** → 401, aucune écriture ;
  - payload **altéré** après signature (montant modifié) → 401 ;
  - signature valide mais montant **incohérent** avec la réservation → 404 ;
  - **rejeu** sur une réservation déjà confirmée → rejet, pas de double paiement.
- **Suite complète** : `14 fichiers / 45 tests` au vert, checkout normal inclus (voir `passing-tests.png`).

## 7. Conclusion

La faille illustre A08:2025 : un chemin d'écriture privilégié sans contrôle d'intégrité. La remédiation consiste à appliquer **la même règle de confiance** (signature HMAC sur payload canonique) à toutes les entrées qui modifient l'état de paiement, et à rendre l'opération **idempotente** pour résister au rejeu.

## 8. Preuves (`evidence/task7`)

| Fichier | Contenu |
|---|---|
| `flag.txt` | `FLAG{a08_5e07fef869a8cbb944642747}` |
| `vulnerability.png` | Flag retourné par le callback non signé (DevTools) |
| `remediation.png` | Même requête rejetée en 401 après correctif |
| `passing-tests.png` | Suite complète : 14 fichiers / 45 tests au vert |