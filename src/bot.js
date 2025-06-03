'use strict';

import { 
  Client, 
  GatewayIntentBits, 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  EmbedBuilder, 
  ActivityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import fs from 'fs/promises';
import * as dotenv from 'dotenv';

// Chargement des variables d'environnement
dotenv.config();

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('⚠️ Les variables DISCORD_TOKEN et CLIENT_ID doivent être définies.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const connectedChannels = new Map();
const relayMap = new Map(); 
const DATA_FILE = './channels.json';

// Regex pour encoder les mentions (@user, @role, @everyone, @here)
const mentionRegex = /<@[!&]?\d+>|@everyone|@here/g;

// Fonction pour encoder les mentions
function encodeMentions(content) {
  return content.replace(mentionRegex, match => `\`${match}\``);
}

// --- Fonctions utilitaires pour la persistance des channels ---

async function loadChannels() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    if (data.trim() === '') {
      console.log('📂 Fichier channels.json vide, initialisation avec un objet vide.');
      await fs.writeFile(DATA_FILE, JSON.stringify({}, null, 2));
      return;
    }
    const parsed = JSON.parse(data);
    for (const [key, value] of Object.entries(parsed)) {
      connectedChannels.set(key, value);
    }
    console.log('📂 Données chargées depuis channels.json');
  } catch (error) {
    if (error.code === 'ENOENT' || error.message.includes('Unexpected end of JSON input')) {
      console.log('📂 Aucun fichier channels.json trouvé ou vide, création d’un nouveau fichier.');
      await fs.writeFile(DATA_FILE, JSON.stringify({}, null, 2));
    } else {
      console.error('❌ Erreur lors du chargement de channels.json:', error.message);
    }
  }
}

async function saveChannels() {
  try {
    const currentData = Object.fromEntries(connectedChannels);
    const fileData = await fs.readFile(DATA_FILE, 'utf8').then(data => JSON.parse(data)).catch(() => ({}));
    if (JSON.stringify(currentData) !== JSON.stringify(fileData)) {
      await fs.writeFile(DATA_FILE, JSON.stringify(currentData, null, 2));
      console.log('💾 Données sauvegardées dans channels.json');
    } else {
      console.log('💾 Aucune modification, fichier channels.json non modifié.');
    }
  } catch (error) {
    console.error('❌ Erreur lors de la sauvegarde:', error);
  }
}

process.on('SIGINT', async () => {
  await saveChannels();
  client.destroy();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await saveChannels();
  client.destroy();
  process.exit(0);
});
process.on('uncaughtException', async (err) => {
  console.error('❌ Erreur non capturée:', err);
  await saveChannels();
  client.destroy();
  process.exit(1);
});

// --- Commandes slash ---

const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer les connexions inter-serveurs')
    .addSubcommand(subcommand =>
      subcommand
        .setName('generer')
        .setDescription('Générer une fréquence pour un interserveur')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lier')
        .setDescription('Lier ce salon à une fréquence')
        .addStringOption(option =>
          option.setName('frequence')
            .setDescription('La fréquence à lier')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('gerer')
        .setDescription('Voir la fréquence du salon')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('liste')
        .setDescription('Voir la liste des serveurs ayant généré une fréquence')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delier')
        .setDescription('Délier ce salon de sa fréquence')
    )
].map(cmd => cmd.toJSON());

// --- Mise à jour de l'activité ---

function updateActivity() {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
}

// --- Événements ---

client.on("guildCreate", async guild => {
  updateActivity();
});

client.on("guildDelete", async guild => {
  updateActivity();
  for (const [frequency, channelSet] of connectedChannels) {
    channelSet.channels = channelSet.channels.filter(channelId => {
      const channel = client.channels.cache.get(channelId);
      return channel && channel.guildId !== guild.id;
    });
    if (channelSet.channels.length === 0) {
      connectedChannels.delete(frequency);
    } else {
      connectedChannels.set(frequency, channelSet);
    }
  }
  await saveChannels();
});

client.on('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}!`);
  await loadChannels();
  updateActivity();

  if (connectedChannels.size === 0) {
    console.warn('⚠️ Aucune fréquence trouvée dans connectedChannels.');
  }

  for (const [frequency, { channels }] of connectedChannels) {
    if (!channels.length) {
      console.warn(`⚠️ Fréquence ${frequency} sans salons.`);
      continue;
    }
    const originChannelId = channels[0];
    try {
      const channel = await client.channels.fetch(originChannelId);
      if (channel?.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
        const guildIcon = channel.guild.iconURL({ dynamic: true }) || null;
        const embed = new EmbedBuilder()
          .setTitle('🤖 Bot en ligne !')
          .setDescription('Le bot est en ligne (ou a redémarré) et prêt à relayer les messages entre serveurs via des fréquences. Utilisez `/interserveur` pour gérer les connexions.')
          .setThumbnail(guildIcon)
          .addFields(
            { name: '🏠 Serveurs', value: `${client.guilds.cache.size}`, inline: true },
            { name: '👥 Utilisateurs', value: `${client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)}`, inline: true }
          )
          .setColor('#99FF99')
          .setTimestamp()
          .setFooter({ text: 'Bot Status', iconURL: guildIcon });
        await channel.send({ embeds: [embed] });
      } else {
        console.warn(`⚠️ Permissions insuffisantes ou salon non textuel pour ${originChannelId}`);
      }
    } catch (error) {
      console.error(`❌ Erreur lors de l'envoi de l'embed au salon ${originChannelId}:`, error.message);
    }
  }

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('📡 Commandes slash enregistrées !');
  } catch (error) {
    console.error('❌ Erreur lors de l’enregistrement des commandes:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.replied || interaction.deferred) return;

  if (interaction.commandName === 'interserveur') {
    const { options } = interaction;
    const subcommand = options.getSubcommand();

    if (subcommand === 'generer') {
      const frequency = Math.random().toString(36).substring(2, 10);
      connectedChannels.set(frequency, { frequency, channels: [interaction.channelId] });
      await saveChannels();
      await interaction.reply({ content: `📡 Fréquence générée : **${frequency}**`, ephemeral: true });
    }

    if (subcommand === 'lier') {
      const frequency = options.getString('frequence');
      const channelSet = connectedChannels.get(frequency);

      if (!channelSet) {
        await interaction.reply({ content: '❌ Fréquence invalide.', ephemeral: true });
        return;
      }

      if (channelSet.channels.includes(interaction.channelId)) {
        await interaction.reply({ content: '⚠️ Ce salon est déjà lié à cette fréquence.', ephemeral: true });
        return;
      }

      channelSet.channels.push(interaction.channelId);
      connectedChannels.set(frequency, channelSet);
      await saveChannels();
      await interaction.reply({ content: `🔗 Salon lié à la fréquence **${frequency}**. Les messages seront maintenant relayés.`, ephemeral: true });

      const content = `📢 Nouveau salon connecté à la fréquence **${frequency}** : ${interaction.guild.name} (${interaction.channel.name})`;
      for (const channelId of channelSet.channels) {
        if (channelId !== interaction.channelId) {
          try {
            const channel = await client.channels.fetch(channelId);
            if (channel?.isTextBased()) {
              await channel.send({ content });
            }
          } catch (error) {}
        }
      }
    }

    if (subcommand === 'gerer') {
      const frequency = [...connectedChannels.entries()].find(([_, v]) => v.channels[0] === interaction.channelId)?.[0];
      if (frequency) {
        await interaction.reply({ content: `📡 Ce salon a généré la fréquence **${frequency}**`, ephemeral: true });
      } else {
        await interaction.reply({ content: '⚠️ Ce salon n’a généré aucune fréquence.', ephemeral: true });
      }
    }

    if (subcommand === 'delier') {
      let found = false;
      for (const [frequency, channelSet] of connectedChannels) {
        if (channelSet.channels.includes(interaction.channelId)) {
          found = true;
          channelSet.channels = channelSet.channels.filter(id => id !== interaction.channelId);
          await interaction.reply({ content: `🔌 Salon délié de la fréquence **${frequency}**`, ephemeral: true });

          const content = `📢 Le salon ${interaction.guild.name} (${interaction.channel.name}) a délié la fréquence **${frequency}**`;
          for (const channelId of channelSet.channels) {
            try {
              const channel = await client.channels.fetch(channelId);
              if (channel?.isTextBased()) {
                await channel.send({ content });
              }
            } catch (error) {}
          }

          if (channelSet.channels.length === 0) {
            connectedChannels.delete(frequency);
          } else {
            connectedChannels.set(frequency, channelSet);
          }
          await saveChannels();
          break;
        }
      }
      if (!found) {
        await interaction.reply({ content: '⚠️ Ce salon n’est lié à aucune fréquence.', ephemeral: true });
      }
    }

    if (subcommand === 'liste') {
      const serverMap = new Map();
      for (const [frequency, { channels }] of connectedChannels) {
        const originChannelId = channels[0];
        const originChannel = await client.channels.fetch(originChannelId);
        const originGuild = originChannel.guild;
        const guildIds = new Set();
        for (const channelId of channels) {
          const channel = await client.channels.fetch(channelId);
          guildIds.add(channel.guildId);
        }
        const liaisonCount = guildIds.size;
        if (!serverMap.has(originGuild.id)) {
          serverMap.set(originGuild.id, { name: originGuild.name, frequency, liaisonCount });
        }
      }

      const servers = Array.from(serverMap.values());
      if (servers.length === 0) {
        await interaction.reply({ content: '⚠️ Aucun serveur a généré de fréquence.', ephemeral: true });
        return;
      }

      const itemsPerPage = 5;
      const totalPages = Math.ceil(servers.length / itemsPerPage);
      let page = 0;

      const getPageContent = (page) => {
        const start = page * itemsPerPage;
        const end = start + itemsPerPage;
        const pageServers = servers.slice(start, end);

        const embed = new EmbedBuilder()
          .setTitle('🌐 Serveurs avec Fréquences')
          .setDescription('📋 Liste des serveurs ayant généré une fréquence.')
          .setColor('#FFD700')
          .setTimestamp();

        pageServers.forEach(s => {
          embed.addFields({
            name: `🏠 ${s.name}`,
            value: `🔗 Liaisons: ${s.liaisonCount} serveur${s.liaisonCount > 1 ? 's' : ''}\n📡 Fréquence: \`\`\`${s.frequency}\`\`\``,
            inline: false
          });
        });

        embed.setFooter({ text: `📄 Page ${page + 1}/${totalPages}` });

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('prev_page')
              .setLabel('⬅️ Précédent')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('next_page')
              .setLabel('Suivant ➡️')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(page === totalPages - 1)
          );

        return {
          embeds: [embed],
          components: [row]
        };
      };

      await interaction.reply({ ...getPageContent(page), ephemeral: true });

      const message = await interaction.fetchReply();

      const filter = i =>
        i.user.id === interaction.user.id &&
        (i.customId === 'prev_page' || i.customId === 'next_page');
      const collector = message.createMessageComponentCollector({ filter, time: 60000 });

      collector.on('collect', async i => {
        if (i.customId === 'prev_page' && page > 0) {
          page--;
        }
        if (i.customId === 'next_page' && page < totalPages - 1) {
          page++;
        }
        await i.update({ ...getPageContent(page), ephemeral: true });
      });

      collector.on('end', async () => {
        try {
          await message.edit({
            ...getPageContent(page),
            components: []
          });
        } catch (e) {}
      });
    }
  }
});

// --- Relais des messages, images, suppression automatique des stickers ---

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // On regarde si le message est dans un channel connecté
  const frequency = [...connectedChannels.entries()].find(([_, v]) => v.channels.includes(message.channelId))?.[0];

  // --- Suppression automatique des stickers ---
  if (frequency && message.stickers && message.stickers.size > 0) {
    try {
      await message.delete();
    } catch (err) {
      console.error("Erreur lors de la suppression du sticker :", err.message);
    }
    return; 
  }

  // Gestion des réponses relayées (texte + images/fichiers)
  if (message.reference && message.reference.messageId) {
    const relayInfo = relayMap.get(message.reference.messageId);
    if (relayInfo) {
      const originalChannel = await client.channels.fetch(relayInfo.originalChannelId);
      if (!originalChannel) return;
      const originalMessage = await originalChannel.messages.fetch(relayInfo.originalId).catch(() => null);

      let replyContent = `💬 **@${message.author.username}** (${message.guild.name}) a répondu :\n> ${message.content}`;
      if (originalMessage) {
        replyContent = `<@${originalMessage.author.id}>, **@${message.author.username}** (${message.guild.name}) a répondu à votre message:\n> ${originalMessage.content}\n\n${message.content}`;
      }

      // Préparer les fichiers attachés
      const files = message.attachments.size > 0 ? Array.from(message.attachments.values()).map(att => att.url) : [];

      // Préparer les embeds d'image
      const imageEmbeds = message.embeds.filter(e => e.image && e.image.url).map(e => e.image.url);

      // Envoyer la réponse avec fichiers
      const sent = await originalChannel.send({
        content: replyContent,
        files: files.length > 0 ? files : undefined,
      });

      // Envoyer les images embeds séparément
      for (const url of imageEmbeds) {
        await originalChannel.send({ files: [url] });
      }

      // Gérer la map des messages relayés pour les réponses
      relayMap.set(sent.id, {
        originalId: message.id,
        originalChannelId: message.channelId
      });

      return;
    }
  }

  // Si pas de fréquence (canal non relié), on ne fait rien
  if (!frequency) return;

  const channelSet = connectedChannels.get(frequency);

  // Préparer le contenu principal avec mentions encodées
  const encodedContent = message.content ? encodeMentions(message.content) : "";
  const relayContent = `💬 **@${message.author.username}** (${message.guild.name})\n${encodedContent}`;

  // Préparer les fichiers attachés (images, vidéos, etc.)
  const files = message.attachments.size > 0 ? Array.from(message.attachments.values()).map(att => att.url) : [];

  // Préparer les embeds d'image (pour images collées qui ne sont pas des fichiers)
  const imageEmbeds = message.embeds
    .filter(e => e.image && e.image.url)
    .map(e => e.image.url);

  // Relayer sur tous les autres channels de la fréquence
  for (const channelId of channelSet.channels) {
    if (channelId !== message.channelId) {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased()) continue;

        // Envoyer le texte + fichiers (si fichiers)
        const sent = await channel.send({
          content: relayContent,
          files: files.length > 0 ? files : undefined,
        });

        // Envoyer les embeds d'image (pour images collées qui ne sont pas des fichiers)
        for (const url of imageEmbeds) {
          await channel.send({ files: [url] });
        }

        // Gérer la map des messages relayés pour les réponses
        relayMap.set(sent.id, {
          originalId: message.id,
          originalChannelId: message.channelId
        });
      } catch (error) {
        console.error(`❌ Erreur lors de l'envoi du message au salon ${channelId}:`, error.message);
      }
    }
  }
});

// --- Connexion du bot ---

client.login(process.env.DISCORD_TOKEN)
  .then(() => console.log("✅ Le bot s'est connecté avec succès à Discord et est prêt à fonctionner."))
  .catch(error => {
    console.error("⚠️ Une erreur s'est produite lors de la tentative de connexion du bot à Discord.");
    console.error("⚠️ Vérifiez que le jeton DISCORD_TOKEN est correct et configuré dans les variables d'environnement.");
    console.error("❌ Erreur de connexion:", error);
    process.exit(1);
  });
