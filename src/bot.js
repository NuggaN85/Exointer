'use strict';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType, PermissionsBitField, WebhookClient, EmbedBuilder } from 'discord.js';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
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

const db = new Database('./data.db', { verbose: console.log });
const connectedChannels = new Map(); // guildId -> channelId
const relayMap = new Map(); // messageId -> { originalId, originalChannelId, timestamp }
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
    not_owner: '❌ Cette interaction ne vous appartient pas.'
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

setInterval(() => {
  const now = Date.now();
  for (const [id, { timestamp }] of relayMap.entries()) {
    if (now - timestamp > RELAY_MAP_TTL) relayMap.delete(id);
  }
}, 60 * 60 * 1000);

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
  client.user.setActivity(`Je suis sur ${serverCount} serveurs`, { type: ActivityType.Custom });
};

const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer la connexion au réseau inter-serveurs')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addSubcommand(sub => sub.setName('config').setDescription('Configurer ce salon'))
    .addSubcommand(sub => sub.setName('deconfig').setDescription('Déconnecter ce salon'))
    .addSubcommand(sub => sub.setName('stats').setDescription('Afficher les statistiques'))
].map(cmd => cmd.toJSON());

client.on('guildCreate', updateActivity);
client.on('guildDelete', async guild => {
  connectedChannels.delete(guild.id);
  db.prepare('DELETE FROM guilds WHERE guild_id = ?').run(guild.id);
  await saveData();
  updateActivity();
});

client.on('ready', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  await loadData();
  updateActivity();
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commandes enregistrées');
  } catch (error) {
    console.error('❌ Erreur commandes:', error);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
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
      const notification = `🆕 **Nouveau serveur connecté !**\n**${interaction.guild.name}** a rejoint le réseau.`;
      await Promise.allSettled(
        Array.from(connectedChannels.keys())
          .filter(id => id !== guildId)
          .map(async id => {
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
      const embed = new EmbedBuilder()
        .setTitle('📊 Statistiques du Réseau Inter-Serveurs')
        .setDescription(LANGUAGES.fr.server_count.replace('{count}', serverCount))
        .setColor('#00AAFF')
        .setTimestamp();
      if (serverCount > 0) {
        const serverList = Array.from(connectedChannels.keys())
          .slice(0, 15)
          .map(guildId => {
            const guild = client.guilds.cache.get(guildId);
            return guild ? `• **${guild.name}**` : `• Serveur inconnu (${guildId})`;
          })
          .join('\n');
        embed.addFields({ name: `Serveurs connectés (${serverCount})`, value: serverList + (serverCount > 15 ? `\n... et ${serverCount - 15} autres` : '') });
      }
      return interaction.editReply({ embeds: [embed] });
    }
  } catch (err) {
    console.error('❌ Erreur interaction:', err.message);
    await interaction.editReply({ content: '❌ Une erreur est survenue.' }).catch(() => {});
  }
});

client.on('messageCreate', async message => {
  const guildId = message.guildId;
  const connectedChannelId = connectedChannels.get(guildId);
  if (!connectedChannelId || message.channelId !== connectedChannelId || message.author.bot) return;
  if (message.stickers.size > 0) {
    await message.delete().catch(err => console.error('⚠️ Erreur suppression sticker:', err.message));
    return;
  }
  const content = await encodeMentions(message.content || '', client);
  const files = Array.from(message.attachments.values()).filter(att => att.size <= MAX_FILE_SIZE).map(att => att.url);
  const embedUrls = message.embeds.filter(e => e.image?.url).map(e => e.image.url);
  const targetChannelIds = Array.from(connectedChannels.entries())
    .filter(([id]) => id !== guildId)
    .map(([, chId]) => chId);

  const sendRelay = async (channel, contentToSend, username, avatarURL) => {
    if (!channel?.isTextBased() || !channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
      console.warn(LANGUAGES.fr.missing_access.replace('{channelId}', channel.id).replace('{guildName}', channel.guild?.name || 'Inconnu'));
      return null;
    }
    const webhook = await getWebhook(channel);
    if (!webhook) return null;
    try {
      const sent = await webhook.send({
        content: message.channel.isThread() ? `[Thread: ${message.channel.name}] ${contentToSend}` : contentToSend,
        username,
        avatarURL,
        files
      });
      relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
      for (const url of embedUrls) {
        await webhook.send({ username, avatarURL, files: [url] }).catch(err => console.error('❌ Erreur envoi embed:', err.message));
      }
      return sent;
    } catch (err) {
      console.error(`❌ Erreur envoi webhook canal ${channel.id}:`, err.message);
      return null;
    }
  };

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

      await Promise.allSettled(targetChannelIds.map(async id => {
        const channel = await client.channels.fetch(id).catch(() => null);
        if (channel) {
          const isOriginalChannel = channel.id === relayed.originalChannelId;
          await sendRelay(channel, isOriginalChannel ? originalReplyContent : relayReplyContent, message.author.username, message.author.displayAvatarURL());
        }
      }));
      return;
    }
  }

  // Gestion des messages normaux
  await Promise.allSettled(targetChannelIds.map(async id => {
    const channel = await client.channels.fetch(id).catch(() => null);
    if (channel) await sendRelay(channel, content, message.author.username, message.author.displayAvatarURL());
  }));
});

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
    if (targetMessage) await targetMessage.react(reaction.emoji.id || reaction.emoji.name).catch(err => console.error('❌ Erreur réaction:', err.message));
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
      if (targetReaction) await targetReaction.users.remove(user.id).catch(err => console.error('❌ Erreur suppression réaction:', err.message));
    }
  }
});

const handleExit = (signal) => {
  try {
    saveData();
    db.close();
    console.log(`💾 Données sauvegardées (${signal})`);
    process.exit(0);
  } catch (error) {
    console.error(`❌ Erreur sauvegarde ${signal}:`, error.message);
    process.exit(1);
  }
};

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
process.on('uncaughtException', err => {
  console.error('❌ Erreur fatale:', err);
  handleExit('uncaughtException');
});
process.on('unhandledRejection', err => {
  console.error('❌ Erreur non gérée:', err);
  handleExit('unhandledRejection');
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('❌ Erreur connexion:', error.message);
  process.exit(1);
});
