**`Mise à jour : version 1.0.4`**

# Exointer Discord Bot

Un bot Discord qui permet de relayer des messages entre différents serveurs via des fréquences uniques.

## Description

Ce bot Discord permet aux utilisateurs de créer des connexions inter-serveurs en générant des fréquences uniques. Les messages envoyés dans un canal lié à une fréquence sont relayés à tous les autres canaux liés à la même fréquence. Cela permet une communication fluide et intégrée entre plusieurs serveurs Discord.

## Fonctionnalités

- Génération de fréquences uniques pour les connexions inter-serveurs.
- Liaison et déliaison de canaux à des fréquences.
- Relai des messages texte et des fichiers entre les canaux connectés.
- Suppression automatique des stickers.
- Gestion des réponses aux messages relayés.
- Commandes slash pour une interaction facile avec le bot.

## Prérequis

- Node.js (version 16 ou supérieure)
- Un bot Discord (créé via le [Portail Développeur Discord](https://discord.com/developers/applications))
- Les permissions nécessaires pour ajouter le bot à vos serveurs

## Installation

1. Clonez ce dépôt sur votre machine locale.
2. Installez les dépendances nécessaires en exécutant `npm install`.
3. Créez un fichier `.env` à la racine du projet et ajoutez vos variables d'environnement :

```plaintext
DISCORD_TOKEN=VOTRE_TOKEN_DE_BOT
CLIENT_ID=VOTRE_CLIENT_ID
```

4. Exécutez le bot avec la commande `node index.js`.

## Commandes

Le bot utilise des commandes slash pour interagir avec les utilisateurs. Voici les commandes disponibles :

- `/interserveur generer` : Génère une nouvelle fréquence pour un inter-serveur.
- `/interserveur lier <frequence>` : Lie le canal actuel à une fréquence existante.
- `/interserveur gerer` : Affiche la fréquence du canal actuel.
- `/interserveur liste` : Affiche la liste des serveurs ayant généré une fréquence.
- `/interserveur delier` : Délie le canal actuel de sa fréquence.

## Utilisation

1. Invitez le bot sur votre serveur Discord en utilisant le lien OAuth2 généré dans le [Portail Développeur Discord](https://discord.com/developers/applications).
2. Utilisez la commande `/interserveur generer` pour créer une nouvelle fréquence.
3. Utilisez la commande `/interserveur lier <frequence>` pour lier un canal à une fréquence existante.
4. Envoyez des messages dans le canal lié, et ils seront relayés à tous les autres canaux liés à la même fréquence.

## Contribution

Les contributions sont les bienvenues ! Pour contribuer à ce projet, veuillez suivre ces étapes :

1. Fork ce dépôt.
2. Créez une branche pour votre fonctionnalité (`git checkout -b feature/AmazingFeature`).
3. Commitez vos changements (`git commit -m 'Add some AmazingFeature'`).
4. Poussez vers la branche (`git push origin feature/AmazingFeature`).
5. Ouvrez une Pull Request.

## Licence

Ce projet est sous licence MIT. Voir le fichier [LICENSE](LICENSE) pour plus de détails.

## Contact

Pour toute question ou suggestion, n'hésitez pas à ouvrir une issue ou à me contacter directement.

---

[![Donate](https://img.shields.io/badge/paypal-donate-yellow.svg?style=flat)](https://www.paypal.me/nuggan85) [![v1.0.4](http://img.shields.io/badge/zip-v1.0.4-blue.svg)](https://github.com/NuggaN85/Exointer/archive/master.zip) [![GitHub license](https://img.shields.io/github/license/NuggaN85/Exointer)](https://github.com/NuggaN85/Exointer)

© 2025 Ludovic Rose. Tous droits réservés.
