# Not TPG — règles de travail

- Communication en **français**.
- App web en un seul fichier (`index.html`, JS sans build) + fonctions Vercel dans `api/`.
- **À chaque mise en ligne** :
  - incrémenter `CACHE` dans `sw.js` **et** `APP_VERSION` dans `index.html` (même numéro) — le message « Application mise à jour » s'affiche une fois par version ;
  - **mettre à jour les tutoriels** (`TUTOS` dans `index.html`, et l'accueil `WELCOME` si besoin) : en créer, en supprimer ou en adapter, quand le changement est pertinent pour les utilisateurs (pas pour le panneau admin ni les détails techniques).
- Retirer les workflows / endpoints de test temporaires après usage.
- Ne rien reprendre d'Atlas RCT, et ne pas le mentionner dans l'app.
- Ne pas contourner les protections des sites sources (ex. blocage Imperva de tpg.ch) : pas de navigateur automatisé, proxys résidentiels ou API privées.
- Ne jamais écrire de code secret en clair dans le dépôt (il est public) : seulement des empreintes de codes longs.
