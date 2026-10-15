# A05 - Search Party Crasher

## Résumé

La route publique `GET /api/trips` construisait sa clause `WHERE` en concaténant
directement le paramètre de recherche `q` dans la requête SQL envoyée à
PostgreSQL. Une entrée contenant une apostrophe — comme la destination
légitime **« Côte d'Ivoire »** — cassait la syntaxe de la requête, et une
entrée conçue avec `') OR 1=1 --` permettait de contourner le filtre
`is_published=true`, exposant un voyage interne non publié et son flag de
démonstration.

## Vulnérabilité

**Fichier concerné :** `apps/api/src/routes/catalog.ts`

**Code vulnérable :**

```ts
const filter = query
  ? ` AND (title ILIKE '%${query}%' OR destination ILIKE '%${query}%' OR description ILIKE '%${query}%')`
  : '';
const result = await pool.query(
  `SELECT id,slug,title,destination,description,departure_date,return_date,price_cents,seats_available,image_key
   FROM trips
   WHERE is_published=true${filter}
   ORDER BY departure_date`
);
```

Le paramètre `query` (issu de `?q=`) était inséré tel quel entre guillemets
simples dans trois clauses `ILIKE`, sans échappement ni binding. Le seul
garde-fou en place (`query.includes(';')`) bloquait les instructions
empilées, mais pas la modification du prédicat `WHERE` lui-même.

Cette faille n'exige même pas d'intention malveillante pour se déclencher :
un voyageur cherchant simplement une destination contenant une apostrophe,
comme **« Côte d'Ivoire »**, suffit à casser la requête SQL et à provoquer
une erreur 500, révélant que l'entrée est interprétée comme du SQL plutôt
que comme une simple valeur de recherche.

## Preuve de concept

1. **Confirmation de l'injection** - une recherche sur une destination
   légitime contenant une apostrophe (`q=Côte d'Ivoire`) provoque une erreur
   500 (`Une erreur interne est survenue`), confirmant que l'entrée casse la
   syntaxe SQL.

2. **Exploitation** - le payload suivant ferme la chaîne et le groupe de
   recherche, puis commente le reste de la clause avec `--` :

```
   q=') OR 1=1 --
```

   Requête encodée :

```
   GET /api/trips?q=%27%29%20OR%201%3D1%20--
```

   La clause effective devient :

```sql
   WHERE is_published=true AND (title ILIKE '%') OR 1=1
```

   `1=1` étant toujours vrai, le filtre `is_published=true` est contourné et
   **tous** les voyages sont retournés, y compris l'enregistrement interne
   `archive-search-party` (non publié).

3. **Flag récupéré :**

```
   FLAG{a05_483c69a2f3d7e3b554851e3d}
```

   Visible dans le champ `description` de l'enregistrement
   `archive-search-party` (voir `vulnerability.png`).

## Remédiation

Remplacement de la concaténation par du binding de paramètres PostgreSQL
(`$1`), afin que l'entrée utilisateur soit toujours traitée comme une donnée,
jamais comme du SQL exécutable.

**Code corrigé :**

```ts
const filter = query
  ? ' AND (title ILIKE $1 OR destination ILIKE $1 OR description ILIKE $1)'
  : '';
const values = query ? [`%${query}%`] : [];

const result = await pool.query(
  `SELECT id,slug,title,destination,description,departure_date,return_date,price_cents,seats_available,image_key
   FROM trips
   WHERE is_published=true${filter}
   ORDER BY departure_date`,
  values
);
```

Le check `query.includes(';')` a été laissé en place (inoffensif) mais n'est
plus le mécanisme de protection réel.

### Vérification post-fix

- Une recherche sur « Côte d'Ivoire » ne provoque plus d'erreur 500 : l'
  apostrophe est désormais traitée comme un simple caractère de la valeur
  recherchée, pas comme de la syntaxe SQL.
- La même requête d'injection (`q=') OR 1=1 --`) retourne désormais un
  **200** avec `{"trips":[]}` : aucun résultat, aucune fuite du voyage caché
  ni du flag (voir `remediation.png`).
- Une recherche normale (`q=lisbonne`, `q=Kyoto`) continue de fonctionner et
  retourne les voyages publiés correspondants.

## Tests automatisés

Fichier : `tests/api/a05-injection.test.ts` (Vitest), 3 cas :

1. **Parameter binding** - vérifie que le SQL envoyé à `pool.query` contient
   bien `$1` et jamais la chaîne `1=1`, et que la valeur de recherche est
   passée via le tableau de paramètres.
2. **Unpublished-trip exclusion** - vérifie qu'un payload d'injection ne
   retourne aucun résultat et qu'aucun `FLAG{` n'apparaît dans la réponse.
3. **Ordinary search results** - vérifie qu'une recherche normale retourne
   toujours les voyages publiés attendus.

Résultat de la suite complète : **14 fichiers de test, 37 tests, tous
passants** (voir `passing-tests.png`).

## Conclusion

Toutes les valeurs de recherche sont désormais paramétrées, l'enregistrement
interne reste caché, la recherche catalogue fonctionne normalement (y
compris pour des destinations légitimes contenant une apostrophe) et les
tests de régression et métier passent.