'use strict';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType, PermissionsBitField, WebhookClient, EmbedBuilder } from 'discord.js';
import { fileURLToPath } from 'url';
import path from 'path';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';

// Définir __dirname pour les modules ES
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration des variables d'environnement
dotenv.config();

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('⚠️ DISCORD_TOKEN et CLIENT_ID requis.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ]
});

// Initialisation de la base de données SQLite
const db = new Database(path.join(__dirname, 'interservers.db'));
//const db = new Database('./data.db');
const connectedChannels = new Map(); // guildId -> channelId
const relayMap = new Map(); // messageId -> { originalId, originalChannelId, originalGuildId, timestamp }
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes

const LANGUAGES = {
  fr: {
    connected: '🔗 Salon connecté au réseau global : {channel}',
    config_success: '✅ Configuration réussie ! Ce salon est maintenant connecté au réseau inter-serveurs.',
    already_connected: '⚠️ Ce salon est déjà connecté au réseau inter-serveurs.',
    not_connected: '❌ Ce serveur n\'est pas connecté au réseau inter-serveurs.',
    disconnected: '🔓 Salon déconnecté du réseau inter-serveurs.',
    server_count: '🌐 **Réseau Inter-Serveurs**\n📊 **{count}** serveurs connectés',
    missing_access: '⚠️ Accès manquant au canal {channelId} sur le serveur {guildName}.',
    not_owner: '❌ Cette interaction ne vous appartient pas.',
    stats_title: '🌐 Statistiques du Réseau Inter-Serveurs',
    servers_connected: '📊 Serveurs Connectés',
    total_members: '👥 Membres Totaux',
    active_channels: '🔗 Canaux Actifs',
    connected_servers_list: '🏆 Serveurs Connectés'
  }
};

// Initialisation base de données
db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT
  );
`);

const encodeMentions = async (content, client) => {
  if (!content) return '';
  let result = content.replace(/@(everyone|here)/g, '@\u200b$1');
  const mentionRegex = /<@!?(\d{17,20})>/g;
  const matches = [...result.matchAll(mentionRegex)];
  for (const match of matches) {
    const userId = match[1];
    try {
      const user = await client.users.fetch(userId);
      result = result.replace(match[0], `@${user.username}`);
    } catch {
      // Ignorer si utilisateur non trouvé
    }
  }
  return result;
};

const webhookCache = new Map();

const loadData = async () => {
  try {
    connectedChannels.clear();
    const guilds = db.prepare('SELECT * FROM guilds').all();
    for (const { guild_id, channel_id } of guilds) {
      connectedChannels.set(guild_id, channel_id);
    }
    console.log('✅ Données chargées depuis SQLite');
  } catch (error) {
    console.error('❌ Erreur chargement SQLite:', error.message);
  }
};

const saveData = async () => {
  try {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM guilds').run();
      const insertGuild = db.prepare('INSERT OR REPLACE INTO guilds (guild_id, channel_id) VALUES (?, ?)');
      for (const [guildId, channelId] of connectedChannels) {
        insertGuild.run(guildId, channelId);
      }
    });
    transaction();
    console.log('💾 Données sauvegardées dans SQLite');
  } catch (error) {
    console.error('❌ Erreur sauvegarde SQLite:', error);
  }
};

// Nettoyage périodique de la relayMap
setInterval(() => {
  const now = Date.now();
  for (const [id, { timestamp }] of relayMap.entries()) {
    if (now - timestamp > RELAY_MAP_TTL) relayMap.delete(id);
  }
}, 60 * 60 * 1000);

// Sauvegarde périodique
setInterval(saveData, SAVE_INTERVAL);

const getWebhook = async (channel) => {
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
  if (!channel.permissionsFor(client.user).has([PermissionsBitField.Flags.ManageWebhooks, PermissionsBitField.Flags.SendMessages])) {
    console.warn(`⚠️ Permissions insuffisantes pour webhooks dans ${channel.id} (serveur ${channel.guild?.name || 'Inconnu'})`);
    return null;
  }
  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(w => w.owner.id === client.user.id);
    if (!webhook) webhook = await channel.createWebhook({ name: 'Interserveur Relay' });
    const webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
    webhookCache.set(channel.id, webhookClient);
    return webhookClient;
  } catch (err) {
    console.error(`❌ Erreur création webhook pour canal ${channel.id}:`, err.message);
    return null;
  }
};

const updateActivity = () => {
  const serverCount = connectedChannels.size;
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
};

const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer la connexion au réseau inter-serveurs')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addSubcommand(sub => sub.setName('config').setDescription('Configurer ce salon'))
    .addSubcommand(sub => sub.setName('deconfig').setDescription('Déconnecter ce salon'))
    .addSubcommand(sub => sub.setName('stats').setDescription('Afficher les statistiques détaillées'))
].map(cmd => cmd.toJSON());

// Événements du client
client.on('clientReady', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  await loadData();
  updateActivity();
  
  // Enregistrement des commandes slash
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commandes slash enregistrées');
  } catch (error) {
    console.error('❌ Erreur enregistrement commandes:', error);
  }
});

client.on('guildCreate', (guild) => {
  console.log(`➕ Ajouté au serveur: ${guild.name}`);
  updateActivity();
});

client.on('guildDelete', async (guild) => {
  console.log(`➖ Retiré du serveur: ${guild.name}`);
  connectedChannels.delete(guild.id);
  db.prepare('DELETE FROM guilds WHERE guild_id = ?').run(guild.id);
  await saveData();
  updateActivity();
});

// Gestion des interactions (commandes slash)
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Vérifier les permissions
  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return interaction.reply({ content: '❌ Permission "Gérer les salons" requise.', ephemeral: true }).catch(() => {});
  }

  await interaction.deferReply({ ephemeral: true }).catch(err => console.error('❌ Erreur deferReply:', err.message));

  try {
    const guildId = interaction.guildId;
    const subcommand = interaction.options.getSubcommand();
    const channelId = interaction.channelId;

    if (subcommand === 'config') {
      if (connectedChannels.has(guildId)) {
        return interaction.editReply({ content: LANGUAGES.fr.already_connected });
      }

      connectedChannels.set(guildId, channelId);
      await saveData();
      updateActivity();

      // Notification aux autres serveurs
      const notification = `🆕 **Nouveau serveur connecté !**\n**${interaction.guild.name}** a rejoint le réseau inter-serveurs.`;
      
      await Promise.allSettled(
        Array.from(connectedChannels.keys())
          .filter(id => id !== guildId)
          .map(async (id) => {
            const chId = connectedChannels.get(id);
            const channel = await client.channels.fetch(chId).catch(() => null);
            if (channel?.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
              await channel.send(notification).catch(err => console.error(`❌ Erreur notification ${chId}:`, err.message));
            }
          })
      );

      return interaction.editReply({ content: LANGUAGES.fr.config_success });

    } else if (subcommand === 'deconfig') {
      if (!connectedChannels.has(guildId)) {
        return interaction.editReply({ content: LANGUAGES.fr.not_connected });
      }

      connectedChannels.delete(guildId);
      await saveData();
      updateActivity();
      return interaction.editReply({ content: LANGUAGES.fr.disconnected });

    } else if (subcommand === 'stats') {
      const serverCount = connectedChannels.size;
      
      // Calcul des statistiques détaillées
      let totalMembers = 0;
      const serverDetails = [];
      
      for (const [guildId, channelId] of connectedChannels) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
          const memberCount = guild.memberCount;
          totalMembers += memberCount;
          
          // Récupérer le salon configuré
          const channel = guild.channels.cache.get(channelId);
          const channelName = channel ? `#${channel.name}` : `Salon inconnu (${channelId})`;
          
          serverDetails.push({
            name: guild.name,
            memberCount: memberCount,
            channel: channelName,
            guildId: guildId
          });
        }
      }
      
      // Trier par nombre de membres (décroissant)
      serverDetails.sort((a, b) => b.memberCount - a.memberCount);
      
      const embed = new EmbedBuilder()
        .setTitle(LANGUAGES.fr.stats_title)
        .setColor('#00AAFF')
        .setTimestamp()
        .setThumbnail(client.user.displayAvatarURL())
        .addFields(
          {
            name: LANGUAGES.fr.servers_connected,
            value: `**${serverCount}** serveurs`,
            inline: true
          },
          {
            name: LANGUAGES.fr.total_members,
            value: `**${totalMembers.toLocaleString()}** membres`,
            inline: true
          },
          {
            name: LANGUAGES.fr.active_channels,
            value: `**${serverDetails.length}** canaux configurés`,
            inline: true
          }
        );

// Ajouter la liste détaillée des serveurs
if (serverDetails.length > 0) {
  const serverList = serverDetails
    .slice(0, 10) // Limiter à 10 serveurs pour éviter de dépasser la limite
    .map((server, index) => {
      // Récupérer le salon pour avoir son ID
      const channel = client.channels.cache.get(connectedChannels.get(server.guildId));
      const channelMention = channel ? `<#${channel.id}>` : `Salon inconnu (${connectedChannels.get(server.guildId)})`;
      
      return `**${index + 1}. ${server.name}**\n👥 ${server.memberCount.toLocaleString()} membres | ${channelMention}`;
    })
    .join('\n\n');
  
  const titleSuffix = serverCount > 10 ? ` (Top 10/${serverCount})` : ` (${serverCount})`;
  
  embed.addFields({
    name: `${LANGUAGES.fr.connected_servers_list}${titleSuffix}`,
    value: serverList + (serverCount > 10 ? `\n\n... et ${serverCount - 10} autres serveurs` : '')
  });
} else {
  embed.addFields({
    name: LANGUAGES.fr.connected_servers_list,
    value: '🥺 Aucun serveur connecté pour le moment.'
  });
}

return interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('❌ Erreur interaction:', err.message);
    await interaction.editReply({ content: '❌ Une erreur est survenue lors du traitement de la commande.' }).catch(() => {});
  }
});

// Gestion des messages
client.on('messageCreate', async (message) => {
  // Ignorer les messages des bots et ceux qui ne proviennent pas d'un serveur
  if (message.author.bot || !message.guild) return;

  const guildId = message.guildId;
  const connectedChannelId = connectedChannels.get(guildId);
  
  // Vérifier si le message provient d'un salon connecté
  if (!connectedChannelId || message.channelId !== connectedChannelId) return;

  // Bloquer les stickers
  if (message.stickers.size > 0) {
    await message.delete().catch(err => console.error('⚠️ Erreur suppression sticker:', err.message));
    return;
  }

  const content = await encodeMentions(message.content || '', client);
  const files = Array.from(message.attachments.values())
    .filter(att => att.size <= MAX_FILE_SIZE)
    .map(att => att.url);
  
  const embedUrls = message.embeds
    .filter(e => e.image?.url)
    .map(e => e.image.url);

  // Récupérer les canaux cibles (tous sauf celui d'origine)
  const targetChannelIds = Array.from(connectedChannels.entries())
    .filter(([id]) => id !== guildId)
    .map(([, chId]) => chId);

  const sendRelay = async (channel, contentToSend, username, avatarURL, originalGuild) => {
    if (!channel?.isTextBased() || !channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
      console.warn(LANGUAGES.fr.missing_access.replace('{channelId}', channel.id).replace('{guildName}', channel.guild?.name || 'Inconnu'));
      return null;
    }
    
    const webhook = await getWebhook(channel);
    if (!webhook) return null;
    
    try {
      // Ajouter le nom du serveur d'origine au username
      const displayUsername = `${username} [${originalGuild.name}]`;
      
      const sent = await webhook.send({
        content: message.channel.isThread() ? `[Thread: ${message.channel.name}] ${contentToSend}` : contentToSend,
        username: displayUsername,
        avatarURL,
        files
      });
      
      relayMap.set(sent.id, { 
        originalId: message.id, 
        originalChannelId: message.channelId, 
        originalGuildId: originalGuild.id,
        timestamp: Date.now() 
      });
      
      // Envoyer les embeds séparément
      for (const url of embedUrls) {
        await webhook.send({ 
          username: displayUsername, 
          avatarURL, 
          files: [url] 
        }).catch(err => console.error('❌ Erreur envoi embed:', err.message));
      }
      return sent;
    } catch (err) {
      console.error(`❌ Erreur envoi webhook canal ${channel.id}:`, err.message);
      return null;
    }
  };

  // Gestion des réponses aux messages
  if (message.reference?.messageId) {
    const relayed = relayMap.get(message.reference.messageId);
    if (relayed) {
      const originalChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
      if (!originalChannel) return;
      
      const originalMessage = await originalChannel.messages.fetch(relayed.originalId).catch(() => null);
      if (!originalMessage) return;
      
      const originalContent = await encodeMentions(originalMessage.content || 'Message sans texte', client);
      const originalReplyContent = `> Réponse à <@${originalMessage.author.id}> : ${originalContent}\n${content}`;
      const relayReplyContent = `> Réponse à @${originalMessage.author.username} : ${originalContent}\n${content}`;

      await Promise.allSettled(targetChannelIds.map(async (id) => {
        const channel = await client.channels.fetch(id).catch(() => null);
        if (channel) {
          const isOriginalChannel = channel.id === relayed.originalChannelId;
          await sendRelay(
            channel, 
            isOriginalChannel ? originalReplyContent : relayReplyContent, 
            message.author.username, 
            message.author.displayAvatarURL(),
            message.guild
          );
        }
      }));
      return;
    }
  }

  // Gestion des messages normaux
  await Promise.allSettled(targetChannelIds.map(async (id) => {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (channel) {
      await sendRelay(
        channel, 
        content, 
        message.author.username, 
        message.author.displayAvatarURL(),
        message.guild
      );
    }
  }));
});

// Gestion des réactions
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  
  const { message } = reaction;
  const channelId = connectedChannels.get(message.guildId);
  if (!channelId || message.channelId !== channelId) return;
  
  const relayed = relayMap.get(message.id);
  if (relayed) {
    const targetChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
    if (!targetChannel?.isTextBased() || !targetChannel.permissionsFor(client.user).has(['SendMessages', 'ManageMessages'])) return;
    
    const targetMessage = await targetChannel.messages.fetch(relayed.originalId).catch(() => null);
    if (targetMessage) {
      await targetMessage.react(reaction.emoji.id || reaction.emoji.name)
        .catch(err => console.error('❌ Erreur réaction:', err.message));
    }
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  
  const { message } = reaction;
  const channelId = connectedChannels.get(message.guildId);
  if (!channelId || message.channelId !== channelId) return;
  
  const relayed = relayMap.get(message.id);
  if (relayed) {
    const targetChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
    if (!targetChannel?.isTextBased() || !targetChannel.permissionsFor(client.user).has(['SendMessages', 'ManageMessages'])) return;
    
    const targetMessage = await targetChannel.messages.fetch(relayed.originalId).catch(() => null);
    if (targetMessage) {
      const targetReaction = targetMessage.reactions.cache.get(reaction.emoji.id || reaction.emoji.name);
      if (targetReaction) {
        await targetReaction.users.remove(user.id)
          .catch(err => console.error('❌ Erreur suppression réaction:', err.message));
      }
    }
  }
});

// Gestion de la fermeture propre
const handleExit = (signal) => {
  try {
    console.log(`\n${signal} reçu, fermeture en cours...`);
    saveData();
    db.close();
    console.log('💾 Données sauvegardées, base de données fermée.');
    client.destroy();
    console.log('👋 Client Discord déconnecté.');
    process.exit(0);
  } catch (error) {
    console.error(`❌ Erreur lors de la fermeture (${signal}):`, error.message);
    process.exit(1);
  }
};

// Gestion des signaux de fermeture
process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('❌ Erreur fatale non capturée:', err);
  handleExit('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rejetée non gérée:', err);
  handleExit('unhandledRejection');
});

// Connexion du client
client.login(process.env.DISCORD_TOKEN).catch((error) => {
  console.error('❌ Erreur de connexion Discord:', error.message);
  process.exit(1);
});
