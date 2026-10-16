# A09 - The Silent Suitcase (Security Logging and Monitoring Failures)

## 1. Résumé

L'annulation d'une réservation (`POST /api/bookings/:id/cancel`) modifiait l'état métier sans écrire aucun événement dans la piste d'audit. Le support ne pouvait donc pas savoir qui avait annulé, quelle réservation, quand ni avec quel résultat. La route renvoyait en plus un `FLAG{...}` au client.

La correction rend l'annulation atomique avec son audit, trace aussi les tentatives refusées, et supprime le flag de la réponse. L'annulation légitime reste possible.

## 2. Vulnérabilité

- **Route** : `POST /api/bookings/:id/cancel` (`apps/api/src/routes/bookings.ts`)
- **Défaut** : un simple `UPDATE bookings SET status='cancelled'` via `pool.query`, sans transaction et sans appel à `recordAudit()` (`apps/api/src/lib/audit.ts`), contrairement à la création de réservation.
- **Conséquence** : aucune trace de l'annulation, ni de ses échecs (réservation d'un autre voyageur, inexistante, déjà annulée).

## 3. Reproduction

1. Connexion en tant qu'Alice (`alice.martin@example.test`), réservation `HT-ALICE-001` (id `40000000-0000-4000-8000-000000000001`), statut `confirmed`.
2. Annulation via l'application, avec DevTools ouvert (onglet Network).
3. Réponse de `POST /api/bookings/:id/cancel` :
   - `booking.status = "cancelled"`
   - `flag = FLAG{a09_b588e11d40faf69239802782}`
4. Connexion en tant que support, écran **Audit** : pour cette réservation, seuls `booking.created` et `payment.approved` (du 09/10) existaient. Le journal ne contenait que des `auth.login` / `auth.logout` récents. **Aucun événement d'annulation** n'avait été écrit.

Preuves : `flag.txt`, `vulnerability.png`.

## 4. Correction

Fichier modifié : `apps/api/src/routes/bookings.ts`, route `POST /api/bookings/:id/cancel`.

- **Transaction** : `BEGIN`, `SELECT ... FOR UPDATE` sur la réservation (évite deux annulations concurrentes), puis `COMMIT` / `ROLLBACK`.
- **Succès** : l'`UPDATE` et `recordAudit(client, ...)` sont dans la même transaction. Si l'écriture de l'audit échoue, le `ROLLBACK` annule aussi l'annulation (« pas d'audit, pas d'annulation »).
- **Refus tracés** : un événement `booking.cancel.denied` est écrit pour chacun de ces cas, puis `COMMIT` sans aucune modification de la réservation :
  - `not_owner` : réservation d'un autre voyageur,
  - `not_found` : réservation inexistante,
  - `already_cancelled` : réservation déjà annulée.
- **Réponse au client** : un `404` identique pour ces trois cas, afin de ne pas révéler l'existence de la réservation d'un autre voyageur. Un identifiant mal formé renvoie un `400` sans accès à la base.
- **Flag** : il n'est plus renvoyé. L'annulation légitime n'est pas bloquée.

### Contenu des événements

| Champ | Valeur |
|---|---|
| acteur | `user_id` de l'utilisateur authentifié |
| action | `booking.cancelled` ou `booking.cancel.denied` |
| cible | `entity_type = booking`, `entity_id` = id de la réservation |
| résultat | `metadata.result` = `success` ou `denied`, `metadata.reason` pour les refus |
| contexte | `metadata.reference`, `metadata.previousStatus` (succès) |
| date | `created_at` de `audit_events` (valeur par défaut en base) |

Aucun secret n'est écrit dans les métadonnées : ni token, ni mot de passe, ni en-tête `Authorization`, ni numéro de carte, ni corps de requête.

## 5. Vérification après correction

Une **nouvelle** réservation a été créée puis annulée par Alice : `HT-MVAYCKRM-ZDGGY` (id `79f07e75-14c8-4c15-8fff-2bebc7166f9e`).

- Réponse de `POST /api/bookings/:id/cancel` : `booking.status = "cancelled"`, **aucun `flag`**.
- Écran Audit côté support : `booking.created` à 14:36:58 puis `booking.cancelled` à 14:37:04 (16/10/2026), acteur `alice.martin@example.test`.
- Le flux d'audit reste réservé au support (un voyageur n'y a pas accès).

Preuve : `remediation.png`.

## 6. Tests

Fichier : `tests/api/a09-logging-failures.test.ts` (7 tests, faux pool transactionnel : les écritures ne sont visibles qu'au `COMMIT`).

| Test | Vérifie |
|---|---|
| parcours client préservé | annulation d'une réservation à soi : `200`, statut `cancelled`, pas de flag |
| événement de succès | `booking.cancelled` avec acteur, cible, résultat `success`, référence, statut précédent, sans secret |
| réservation d'autrui | `404`, réservation inchangée, événement `booking.cancel.denied` (`not_owner`) |
| réservation inconnue | `404`, événement `denied` (`not_found`) |
| déjà annulée | `404`, réservation inchangée, événement `denied` (`already_cancelled`) |
| identifiant mal formé | `400`, aucun accès à la base |
| atomicité | si l'écriture de l'audit échoue : erreur `5xx`, réservation toujours `confirmed`, aucun événement, connexion libérée |

Résultat de la suite complète : **14 fichiers et 50 tests passés** (`passing-tests.png`). Le log `audit storage unavailable` avec sa stack trace dans la sortie est attendu : c'est la panne simulée par le test d'atomicité.

## 7. Limites et pistes

- L'écran Audit n'affiche que la date, le compte et l'action. La cible et le résultat sont fournis par l'API (`entity_id`, `metadata`), mais ne sont pas affichés à l'écran.
- Les événements `denied` peuvent être générés par n'importe quel utilisateur connecté : une limitation de débit ou une alerte sur les rafales de refus serait utile en production.
- Pour l'investigation, l'adresse IP et l'identifiant de requête pourraient être ajoutés aux métadonnées, si le schéma le permet.

## 8. Livrables (`evidence/task8/`)

- `report.md`
- `flag.txt`
- `vulnerability.png` : flag dans la réponse de `cancel` (DevTools)
- `remediation.png` : annulation d'une réservation fraîche sans flag + événement `booking.cancelled` dans l'audit support
- `passing-tests.png` : suite complète verte