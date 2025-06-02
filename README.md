Bot de Relais Interserveur Discord
Un bot Discord pour relayer messages, images et réponses entre plusieurs serveurs via des fréquences uniques. Sous licence MIT.
Fonctionnalités

Générer une fréquence : Crée une fréquence unique pour la communication interserveur.
Lier des salons : Connecte un salon à une fréquence existante.
Gérer les fréquences : Affiche ou délie les salons d’une fréquence.
Lister les serveurs : Affiche les serveurs ayant généré des fréquences et leurs connexions.
Relais de messages : Transmet textes, images et réponses entre salons liés.
Suppression des stickers : Supprime automatiquement les stickers dans les salons liés.
Persistance : Enregistre les correspondances fréquence-salon dans channels.json.
Pagination : Navigation des listes de serveurs avec boutons pour grands ensembles de données.
Statut d’activité : Affiche le nombre de serveurs connectés au bot.

Commandes
Utilisez /interserveur avec les sous-commandes suivantes :

generer : Crée une nouvelle fréquence pour le salon actuel.
lier  : Lie le salon actuel à une fréquence spécifiée.
gerer : Affiche la fréquence générée par le salon actuel.
liste : Liste les serveurs ayant généré des fréquences et leurs connexions.
delier : Délie le salon actuel de sa fréquence.

Installation

Clonez le dépôt :git clone <url-du-dépôt>
cd <dossier-du-dépôt>


Installez les dépendances :npm install discord.js dotenv fs


Créez un fichier .env à la racine :DISCORD_TOKEN=votre_token_bot
CLIENT_ID=votre_client_id


Lancez le bot :node index.js



Prérequis

Node.js (v16 ou supérieur)
Discord.js (v14 ou supérieur)
Un token de bot Discord et un ID client depuis le Portail Développeur Discord

Structure des fichiers

index.js : Script principal du bot.
channels.json : Stocke les correspondances fréquence-salon (généré automatiquement).
.env : Variables d’environnement pour le token et l’ID client.
package.json : Dépendances et métadonnées du projet.

Utilisation

Invitez le bot sur votre serveur Discord avec les permissions nécessaires (SendMessages, EmbedLinks).
Utilisez /interserveur generer pour créer une fréquence dans un salon.
Partagez la fréquence avec d’autres serveurs pour lier leurs salons avec /interserveur lier <frequence>.
Les messages, images et réponses dans les salons liés seront relayés à tous les salons de la même fréquence.
Utilisez /interserveur liste pour voir les serveurs connectés et leurs fréquences.
Utilisez /interserveur delier pour délier un salon d’une fréquence.

Notes

Le bot nécessite les intents Guilds, GuildMessages et MessageContent.
Les stickers sont automatiquement supprimés dans les salons liés pour une communication propre.
Le bot enregistre les correspondances dans channels.json à la fermeture ou en cas de crash.
Les boutons de pagination pour /interserveur liste sont actifs pendant 60 secondes.

Licence
Ce projet est sous licence MIT. Voir le fichier LICENSE pour plus de détails.
