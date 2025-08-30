'use strict';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType, PermissionsBitField, WebhookClient } from 'discord.js';
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ]
});

const db = new Database('./data.db', { verbose: console.log });
const connectedChannels = new Set();
const relayMap = new Map();
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes

const LANGUAGES = {
  fr: {
    connected: '🔗 Salon connecté : {guild} ({channel})',
    channel_set: '📍 Salon défini pour la connexion interserveur.'
  }
};

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    channel_id TEXT PRIMARY KEY,
    guild_id TEXT
  );
`);

const encodeMentions = content => content
  ? content
      .replace(/@(everyone|here)/g, '@\u200b$1')
      .replace(/<@&?(\d{17,20})>/g, '<@\u200b$1>')
  : '';

const webhookCache = new Map();

const loadData = async () => {
  try {
    connectedChannels.clear();
    const channels = db.prepare('SELECT channel_id FROM channels').all();
    for (const { channel_id } of channels) {
      connectedChannels.add(channel_id);
    }
    console.log('✅ Données chargées depuis SQLite');
  } catch (error) {
    console.error('❌ Erreur chargement SQLite:', error.message);
  }
};

const saveData = async () => {
  try {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM channels').run();
      const insertChannel = db.prepare('INSERT OR REPLACE INTO channels (channel_id, guild_id) VALUES (?, ?)');
      for (const channelId of connectedChannels) {
        const channel = client.channels.cache.get(channelId);
        insertChannel.run(channelId, channel?.guild?.id || 'Inconnu');
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
  for (const [id, { timestamp }] of relayMap) {
    if (now - timestamp > RELAY_MAP_TTL) relayMap.delete(id);
  }
}, 60 * 60 * 1000);

setInterval(saveData, SAVE_INTERVAL);

const getWebhook = async channel => {
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
  if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageWebhooks)) {
    console.warn(`⚠️ Permissions insuffisantes pour webhooks dans ${channel.id}`);
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

const updateActivity = () => client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });

const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer les connexions inter-serveurs')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set-channel')
        .setDescription('Définir ce salon pour la connexion interserveur')
    )
].map(cmd => cmd.toJSON());

client.on('guildCreate', updateActivity);
client.on('guildDelete', async guild => {
  updateActivity();
  db.prepare('DELETE FROM channels WHERE guild_id = ?').run(guild.id);
  await loadData();
});

client.on('clientReady', async () => {
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
  if (!interaction.isCommand() || interaction.replied || interaction.deferred) return;
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return interaction.reply({ content: '❌ Permission "Gérer les salons" requise.', ephemeral: true }).catch(() => {});
  }
  await interaction.deferReply({ ephemeral: true }).catch(err => console.error('❌ Erreur deferReply:', err.message));
  try {
    if (interaction.commandName === 'interserveur' && interaction.options.getSubcommand() === 'set-channel') {
      if (connectedChannels.has(interaction.channelId)) return interaction.editReply({ content: '⚠️ Salon déjà lié.' });
      connectedChannels.add(interaction.channelId);
      db.prepare('INSERT INTO channels (channel_id, guild_id) VALUES (?, ?)').run(
        interaction.channelId, 
        interaction.guildId
      );
      await saveData();
      await interaction.editReply({ content: LANGUAGES.fr.channel_set });
      const content = LANGUAGES.fr.connected.replace('{guild}', interaction.guild.name).replace('{channel}', interaction.channel.name);
      await Promise.all([...connectedChannels].map(async channelId => {
        if (channelId !== interaction.channelId) {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel?.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
            await channel.send({ content }).catch(err => console.error(`❌ Erreur envoi message canal ${channelId}:`, err.message));
          }
        }
      }));
    }
  } catch (err) {
    console.error('❌ Erreur interaction:', err.message);
    await interaction.editReply({ content: '❌ Une erreur est survenue.' }).catch(() => {});
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || message.stickers.size > 0) {
    if (message.stickers.size > 0) await message.delete().catch(err => console.error('⚠️ Erreur suppression sticker:', err.message));
    return;
  }
  if (!connectedChannels.has(message.channelId)) return;
  const content = encodeMentions(message.content || '');
  const files = Array.from(message.attachments.values()).filter(att => att.size <= MAX_FILE_SIZE).map(att => att.url);
  const embeds = message.embeds.filter(e => e.image?.url).map(e => ({ url: e.image.url }));
  const guildName = message.guild?.name || 'Serveur Inconnu';
  
  if (message.reference?.messageId) {
    const relayed = relayMap.get(message.reference.messageId);
    if (relayed) {
      const originalChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
      const originalMessage = await originalChannel?.messages.fetch(relayed.originalId).catch(() => null);
      if (originalMessage) {
        const replyContent = `> <@${originalMessage.author.id}> : ${encodeMentions(originalMessage.content || 'Message sans texte')}\n${content}`;
        const webhook = await getWebhook(originalChannel);
        if (webhook) {
          const sent = await webhook.send({ 
            content: replyContent, 
            username: `${message.author.username} (${guildName})`, 
            avatarURL: message.author.displayAvatarURL(), 
            files 
          }).catch(err => console.error(`❌ Erreur envoi réponse webhook canal ${originalChannel.id}:`, err.message));
          if (sent) {
            relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
            for (const { url } of embeds) {
              await webhook.send({ 
                username: `${message.author.username} (${guildName})`, 
                avatarURL: message.author.displayAvatarURL(), 
                files: [url] 
              }).catch(err => console.error(`❌ Erreur envoi embed réponse webhook canal ${originalChannel.id}:`, err.message));
            }
          }
        }
      }
      return;
    }
  }
  
  await Promise.all([...connectedChannels].map(async channelId => {
    if (channelId === message.channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) return;
    const webhook = await getWebhook(channel);
    if (!webhook) return;
    const sent = await webhook.send({
      content: message.channel.isThread() ? `[Thread: ${message.channel.name}] ${content}` : content,
      username: `${message.author.username} (${guildName})`,
      avatarURL: message.author.displayAvatarURL(),
      files
    }).catch(err => {
      console.error(`❌ Erreur envoi webhook canal ${channelId}:`, err.message);
      return null;
    });
    if (sent) {
      relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
      for (const { url } of embeds) {
        await webhook.send({ 
          username: `${message.author.username} (${guildName})`, 
          avatarURL: message.author.displayAvatarURL(), 
          files: [url] 
        }).catch(err => console.error(`❌ Erreur envoi embed webhook canal ${channelId}:`, err.message));
      }
    }
  }));
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  const { message } = reaction;
  if (!connectedChannels.has(message.channelId)) return;
  await Promise.all([...connectedChannels].map(async channelId => {
    if (channelId !== message.channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const relayed = relayMap.get(message.id);
      if (relayed) {
        const targetChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
        const targetMessage = await targetChannel?.messages.fetch(relayed.originalId).catch(() => null);
        if (targetMessage) await targetMessage.react(reaction.emoji.id || reaction.emoji.name).catch(() => {});
      }
    }
  }));
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  const { message } = reaction;
  if (!connectedChannels.has(message.channelId)) return;
  await Promise.all([...connectedChannels].map(async channelId => {
    if (channelId !== message.channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;
      const relayed = relayMap.get(message.id);
      if (relayed) {
        const targetChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
        const targetMessage = await targetChannel?.messages.fetch(relayed.originalId).catch(() => null);
        if (targetMessage) {
          const targetReaction = targetMessage.reactions.cache.get(reaction.emoji.id || reaction.emoji.name);
          if (targetReaction) await targetReaction.users.remove(user.id).catch(() => {});
        }
      }
    }
  }));
});

const handleExit = signal => {
  try {
    saveData();
    db.close();
    console.log(`💾 Données sauvegardées (${signal})`);
    process.exit(0);
  } catch (error) {
    console.error(`❌ Erreur sauvegarde ${signal}:`, error);
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
  console.error('❌ Erreur connexion système:', error);
  process.exit(1);
});
