# A10 - The Emergency Exit Is Open

**Catégorie OWASP Top 10:2025 :** A10 – Mishandling of Exceptional Conditions (mauvaise gestion des conditions exceptionnelles)
**Route concernée :** `POST /api/bookings/:id/confirm`
**Fichier :** `apps/api/src/routes/bookings.ts`
**Flag :** `FLAG{a10_74172f24080be7bb34474c47}`

## 1. Résumé

Pour confirmer une réservation, le handler exige deux conditions : la réservation est toujours `pending` et son paiement est `approved`. Or, quand ce contrôle obligatoire levait une exception, le bloc `catch` affectait `checksPassed = true`. L'application **échouait donc en mode ouvert** (*fail open*) : un contrôle indisponible était traité comme un contrôle réussi, et une réservation non payée passait au statut `confirmed`.

## 2. Code vulnérable

```ts
let checksPassed = false;
try {
  if (simulateFailure) throw new Error('Local readiness checker unavailable');
  checksPassed = result.rows[0].status === 'pending' && result.rows[0].payment_status === 'approved';
} catch {
  checksPassed = true;            // l'incertitude devient une approbation
}

if (!checksPassed) {
  return reply.code(409).send({ error: 'La réservation ne peut pas encore être confirmée' });
}
await pool.query(`UPDATE bookings SET status='confirmed' WHERE id=$1`, [id]);
```

La branche de validation normale était correcte. La décision dangereuse se trouvait uniquement dans le chemin d'exception.

## 3. Impact

- Une réservation peut être confirmée sans paiement approuvé dès que le contrôle de paiement est indisponible (erreur base de données, timeout, problème réseau).
- L'intégrité métier est rompue : le statut « confirmé » ne prouve plus que le client a payé.
- Dans un système réel, un attaquant capable de provoquer une panne passagère, ou de l'attendre, obtient des réservations confirmées gratuitement.

## 4. Reproduction

Compte utilisé : Alice (client). Une nouvelle réservation non payée a été créée pour le test (`payment_status: null`). La réservation seedée d'Alice n'a pas été utilisée, car elle est déjà payée et confirmée.

Depuis la console DevTools du navigateur, avec la session d'Alice :

```js
const id = '<id de la nouvelle réservation non payée>';
const confirm = body => fetch(`/api/bookings/${id}/confirm`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(async r => console.log(r.status, await r.json()));

await confirm({});                             // chemin normal
await confirm({ simulateCheckFailure: true }); // panne simulée du contrôle
```

| Requête | Avant correctif |
|---|---|
| `{}` | `409` – la réservation ne peut pas être confirmée (correct) |
| `{ "simulateCheckFailure": true }` | `200` – `{ status: "confirmed", flag: "FLAG{a10_...}" }` (vulnérable) |

Preuve : `vulnerability.png`.

## 5. Correctif

La branche d'exception **échoue désormais en mode fermé** (*fail closed*). Elle journalise l'erreur côté serveur et renvoie une erreur générique avant d'atteindre l'`UPDATE` qui modifie l'état :

```ts
} catch (error) {
  // Fail closed : une vérification impossible n'est jamais une approbation.
  request.log.warn({ err: error, bookingId: id }, 'booking confirmation check unavailable');
  return reply.code(503).send({
    error: 'Vérification temporairement indisponible, veuillez réessayer plus tard'
  });
}
```

Autres modifications :

- La réponse de succès est désormais `{ status: 'confirmed' }`. Le flag n'est plus exposé.
- Le destructuring inutilisé de `flags` a été supprimé.
- Le champ `simulateCheckFailure` a été conservé volontairement. Il lève une vraie exception, ce qui prouve que le chemin d'exception lui-même est sûr. Supprimer seulement ce champ masquerait le problème sans le corriger.

Choix de conception :

- **503 Service Unavailable** indique au client que l'échec est temporaire et qu'il peut réessayer.
- **Message générique** : aucun message d'exception, aucune stack trace ni aucun détail interne n'est renvoyé. Les détails vont uniquement dans les logs serveur.
- **Aucune modification d'état** : le handler sort avant l'`UPDATE`, la réservation reste donc `pending`.

## 6. Vérification après correctif

Une nouvelle réservation non payée a été utilisée pour la démonstration.

| Requête | Après correctif |
|---|---|
| `{}` | `409` – refus normal conservé |
| `{ "simulateCheckFailure": true }` | `503` – erreur générique, sans flag, réservation toujours `pending` |

Preuve : `remediation.png`.

## 7. Tests automatisés

Fichier : `tests/api/a10-exceptional-conditions.test.ts`

| Test | Type | Résultat attendu |
|---|---|---|
| Échec fermé quand le contrôle obligatoire est indisponible | Régression sécurité | `503`, corps générique, pas de `FLAG{`, pas de message interne, **aucun** `UPDATE` de confirmation |
| Refus normal conservé quand le paiement est absent | Sécurité / métier | `409`, pas de `FLAG{`, aucun `UPDATE` de confirmation |
| Confirmation d'une réservation `pending` avec paiement approuvé | Métier (cas positif) | `200`, `{ status: 'confirmed' }`, exactement un `UPDATE` de confirmation |

L'ancien test de caractérisation, qui attendait un `200` et un flag, a été transformé en test de régression.

Le test positif s'appuie sur une réservation `pending` avec un paiement `approved`, fournie par le faux pool. Cet état intermédiaire est inatteignable via l'interface, car le paiement normal confirme déjà la réservation.

Résultat de la suite complète : **14 fichiers de test, 51 tests réussis.**

Preuve : `passing-tests.png`.