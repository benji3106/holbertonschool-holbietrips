# A06 - Coupon Carousel

## Résumé

Le endpoint `POST /api/bookings` acceptait plusieurs codes de coupon dans le
champ `couponCode`, pourtant présenté comme un champ unique côté interface.
Le serveur découpait cette chaîne sur la virgule (`split(',')`) sans jamais
vérifier le nombre de valeurs obtenues, puis appliquait une remise pour
*chaque* code trouvé dans une boucle; y compris en répétant plusieurs fois
le même coupon. Un client pouvait ainsi empiler le même coupon de bienvenue
sur une seule réservation et faire chuter le total bien en dessous du prix
attendu, alors que chaque coupon pris individuellement restait parfaitement
valide.

## Reproduction

**Baseline (coupon unique, légitime)**
- Compte : Alice
- Voyage : Lisbonne, 1 voyageur
- Coupon : `BIENVENUE10` (code unique)
- Résultat : réservation créée normalement, remise appliquée une fois.

**Tentative d'exploitation**
- Mêmes paramètres (Alice, même voyage, 1 voyageur)
- Champ `couponCode` contenant le même code répété, séparé par une virgule
- Résultat observé dans la réponse immédiate de création (`POST /api/bookings`,
  capturée dans l'onglet Network des DevTools, avant toute requête de détail
  ultérieure) :
  - La remise a été appliquée deux fois sur le même total
  - Le flag a été retourné dans `itinerary_notes` :
    `FLAG{a06_a7006a3ac15577e51636959b}`

Voir `vulnerability.png`.

## Cause racine

Dans `apps/api/src/routes/bookings.ts`, la route `POST /api/bookings` :

```ts
const couponCodes = readText(body.couponCode, 120)
  .toUpperCase()
  .split(',')
  .map(code => code.trim())
  .filter(Boolean);
```

Rien, entre cette ligne et le début de la transaction, ne limite
`couponCodes` à une seule valeur. La boucle qui suit :

```ts
for (const couponCode of couponCodes) {
  // ...
  total = applyCoupon(total, { ... });
  await client.query('UPDATE coupons SET uses=uses+1 WHERE id=$1', [coupon.id]);
}
```

s'exécute donc une fois par élément du tableau (y compris plusieurs fois
pour le même code) et chaque passage réduit encore le `total` déjà réduit
par le passage précédent. Le problème est une faille de conception
(insecure design, A06) : la règle métier "zéro ou un coupon par réservation"
n'était jamais formalisée côté serveur, alors que chaque coupon pris
isolément passait toutes ses propres vérifications (dates, usages restants,
montant minimum).

## Correctif

Ajout d'une validation explicite, exécutée **avant** toute connexion à la
base de données et avant le début de la transaction :

```ts
if (couponCodes.length > 1) {
  return reply.code(400).send({ error: 'Un seul coupon est autorisé par réservation' });
}
```

Ce choix d'emplacement est intentionnel : une tentative de cumul est
rejetée avant `pool.connect()`, donc avant tout `BEGIN`, tout verrou
`FOR UPDATE` et toute écriture (`UPDATE coupons`, `INSERT INTO bookings`,
`UPDATE trips`). Aucun effet de bord n'a lieu pour une requête invalide.

Le reste de la logique est inchangé :
- le helper `applyCoupon` ;
- le calcul de prix côté serveur (`trip.price_cents * travelers`) ;
- la transaction et les verrous existants ;
- le comportement pour 0 ou 1 coupon, qui continue de fonctionner à
  l'identique.

La branche de réponse qui injectait le flag dans `itinerary_notes`
(`hasMultipleCoupons`) a également été supprimée : elle n'est plus jamais
atteignable une fois la validation en place.

Voir `remediation.png` : la même requête de cumul, rejouée après
correctif, renvoie désormais `400` avec le message
`"Un seul coupon est autorisé par réservation"`, avant toute écriture.

## Tests

Deux catégories de tests ont été ajoutées/mises à jour dans
`tests/api/a06-insecure-design.test.ts` :

1. **Régression sécurité** — une tentative de coupons dupliqués/cumulés
   est rejetée avec un `400`, et aucune requête n'est faite ni sur la
   connexion DB (`pool.connect`) ni sur le client de transaction
   (`client.query`) : la preuve que le rejet intervient bien avant tout
   effet de bord.
2. **Tests métier positifs** — une réservation avec un coupon unique
   valide, et une réservation sans coupon, calculent toutes deux le prix
   correctement et sont acceptées (`201`).

Résultat : 38/38 tests passent, dont les 3 tests du fichier A06.
Voir `passing-tests.png`.

## Conditions d'atterrissage

- Au plus un coupon éligible peut affecter une réservation.
- Les codes dupliqués ou cumulés sont rejetés avant tout accès à la base.
- Le calcul de prix reste entièrement côté serveur.
- Les tests de régression sécurité et métier positifs passent tous les deux.