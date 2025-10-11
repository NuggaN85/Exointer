'use strict';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType, PermissionsBitField, WebhookClient, EmbedBuilder, MessageFlags } from 'discord.js';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { bold, green, blue, yellow, red, magenta, cyan, white, gray } from 'kleur/colors';
dotenv.config();

if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error(red('⚠️ DISCORD_TOKEN et CLIENT_ID requis.'));
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ]
});

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 min
const WEBHOOK_CACHE_TTL = 60 * 60 * 1000; // 1h
const CONNECTED_CHANNELS_TTL = 24 * 60 * 60 * 1000; // 24h
const PROCESSING_DELAY = 100; // 100ms
const HEALTH_CHECK_INTERVAL = 30 * 60 * 1000; // 30 min

const db = new Database('./data.db');
const connectedChannels = new Map(); // Stocke guildId => { channelId, timestamp }
const relayMap = new Map();
const webhookCache = new Map();
const messageQueue = new Map();
const rateLimits = new Map();

const logger = {
  info: (message, data = {}) => console.log(blue(`[${new Date().toISOString()}] 📝 ${message}`), Object.keys(data).length ? gray(JSON.stringify(data)) : ''),
  warn: (message, data = {}) => console.warn(yellow(`[${new Date().toISOString()}] ⚠️ ${message}`), Object.keys(data).length ? gray(JSON.stringify(data)) : ''),
  error: (message, error = null) => console.error(red(`[${new Date().toISOString()}] ❌ ${message}`), error ? red(error.stack) : ''),
  success: (message, data = {}) => console.log(green(`[${new Date().toISOString()}] ✅ ${message}`), Object.keys(data).length ? gray(JSON.stringify(data)) : ''),
  debug: (message, data = {}) => process.env.DEBUG && console.log(gray(`[${new Date().toISOString()}] 🔍 ${message}`), Object.keys(data).length ? gray(JSON.stringify(data)) : ''),
  system: (message, data = {}) => console.log(magenta(`[${new Date().toISOString()}] 🚀 ${message}`), Object.keys(data).length ? gray(JSON.stringify(data)) : ''),
  database: (message, data = {}) => console.log(cyan(`[${new Date().toISOString()}] 💾 ${message}`), Object.keys(data).length ? gray(JSON.stringify(data)) : '')
};

const stats = {
  startTime: Date.now(),
  messagesSent: 0,
  messagesReceived: 0,
  commandsExecuted: 0,
  errors: 0,
  webhooksCreated: 0,
  increment: (category) => stats[category] !== undefined && stats[category]++,
  getUptime: () => {
    const uptime = Date.now() - stats.startTime;
    const days = Math.floor(uptime / (24 * 60 * 60 * 1000));
    const hours = Math.floor((uptime % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((uptime % (60 * 60 * 1000)) / (60 * 1000));
    return `${days}d ${hours}h ${minutes}m`;
  },
  getSummary: () => ({
    uptime: stats.getUptime(),
    servers: client.guilds?.cache.size || 0,
    messagesSent: stats.messagesSent,
    messagesReceived: stats.messagesReceived,
    commandsExecuted: stats.commandsExecuted,
    errors: stats.errors,
    webhooksCreated: stats.webhooksCreated,
    connectedChannels: connectedChannels.size,
    relayMapSize: relayMap.size,
    webhookCacheSize: webhookCache.size,
    messageQueues: messageQueue.size,
    memoryUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`
  }),
  printStats: () => {
    const summary = stats.getSummary();
    console.log('\n' + bold(blue('📊 STATISTIQUES DU BOT INTERSERVEUR')));
    console.log(blue('═'.repeat(50)));
    console.log(green('🕒 Uptime:'), white(summary.uptime));
    console.log(green('🏠 Serveurs:'), white(summary.servers));
    console.log(green('🔗 Canaux connectés:'), white(summary.connectedChannels));
    console.log(blue('─'.repeat(30)));
    console.log(cyan('📨 Messages envoyés:'), white(summary.messagesSent));
    console.log(cyan('📩 Messages reçus:'), white(summary.messagesReceived));
    console.log(cyan('⚡ Commandes exécutées:'), white(summary.commandsExecuted));
    console.log(blue('─'.repeat(30)));
    console.log(magenta('🪝 Webhooks créés:'), white(summary.webhooksCreated));
    console.log(magenta('🗺️ Relay Map:'), white(summary.relayMapSize));
    console.log(magenta('💾 Webhook Cache:'), white(summary.webhookCacheSize));
    console.log(magenta('📋 Files d\'attente:'), white(summary.messageQueues));
    console.log(blue('─'.repeat(30)));
    console.log(yellow('❌ Erreurs:'), summary.errors > 0 ? red(summary.errors) : yellow(summary.errors));
    console.log(yellow('💾 Mémoire:'), white(summary.memoryUsage));
    console.log(blue('═'.repeat(50)) + '\n');
  }
};

const checkRateLimit = (userId, action, limit = 5, window = 60000) => {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const userLimits = rateLimits.get(key) || [];
  const validLimits = userLimits.filter(time => now - time < window);
  validLimits.push(now);
  rateLimits.set(key, validLimits);
  return validLimits.length <= limit;
};

const LANGUAGES = {
  fr: {
    connected: '🔗 Salon configuré : {channel}. Connexion automatique au réseau.',
    unconfigured: '❌ Salon non configuré. Utilisez </interserveur config:1422951272549712035>.',
    rate_limited: '⚠️ Trop de messages envoyés rapidement.',
    missing_access: '⚠️ Accès manquant au canal {channelId} sur le serveur {guildName}.',
    wrong_channel: '❌ Cette commande doit être exécutée dans le salon configuré pour le réseau inter-serveur.'
  }
};

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const resolveMentions = async (content, guild) => {
  if (!content || typeof content !== 'string') return '';
  let resolvedContent = content;
  const userMentions = content.match(/<@!?(\d{17,20})>/g) || [];
  for (const mention of userMentions) {
    const userId = mention.replace(/<@!?(\d{17,20})>/, '$1');
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) resolvedContent = resolvedContent.replace(mention, `@${member.user.username}`);
    } catch {}
  }
  const roleMentions = content.match(/<@&(\d{17,20})>/g) || [];
  for (const mention of roleMentions) {
    const roleId = mention.replace(/<@&(\d{17,20})>/, '$1');
    try {
      const role = await guild.roles.fetch(roleId);
      if (role) resolvedContent = resolvedContent.replace(mention, `@${role.name}`);
    } catch {}
  }
  const channelMentions = content.match(/<#(\d{17,20})>/g) || [];
  for (const mention of channelMentions) {
    const channelId = mention.replace(/<#(\d{17,20})>/, '$1');
    try {
      const channel = await guild.channels.fetch(channelId);
      if (channel) resolvedContent = resolvedContent.replace(mention, `#${channel.name}`);
    } catch {}
  }
  resolvedContent = resolvedContent.replace(/@(everyone|here)/g, '@\u200b$1');
  return resolvedContent;
};

const sendMessageToChannel = async (channelId, content, options = {}) => {
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return null;
    const botPermissions = channel.permissionsFor(client.user);
    if (!botPermissions?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks, PermissionsBitField.Flags.AttachFiles])) return null;
    const webhook = await getWebhook(channel);
    if (!webhook) {
      const result = await channel.send({ content: options.content || content, files: options.files }).catch(() => null);
      if (result) stats.increment('messagesSent');
      return result;
    }
    const sentMessage = await webhook.send({
      content: options.content || content,
      username: options.username,
      avatarURL: options.avatarURL,
      files: options.files
    }).catch(async () => {
      const fallbackContent = options.username ? `**${options.username}**: ${options.content || content}` : (options.content || content);
      const result = await channel.send({ content: fallbackContent, files: options.files }).catch(() => null);
      if (result) stats.increment('messagesSent');
      return result;
    });
    if (sentMessage) stats.increment('messagesSent');
    return sentMessage;
  } catch (error) {
    logger.error(`Erreur envoi canal ${channelId}`, error);
    stats.increment('errors');
    return null;
  }
};

const processMessageQueue = async (channelId) => {
  if (!messageQueue.has(channelId) || messageQueue.get(channelId).length === 0) return;
  const queue = messageQueue.get(channelId);
  const messageData = queue[0];
  try {
    const sentMessage = await sendMessageToChannel(channelId, messageData.content, {
      username: messageData.username,
      avatarURL: messageData.avatarURL,
      files: messageData.files,
      content: messageData.processedContent
    });
    if (sentMessage && messageData.originalId) {
      relayMap.set(sentMessage.id, {
        originalId: messageData.originalId,
        originalChannelId: messageData.originalChannelId,
        timestamp: Date.now()
      });
    }
    queue.shift();
  } catch (error) {
    logger.error(`Erreur file ${channelId}`, error);
    stats.increment('errors');
    queue.shift();
  }
  if (queue.length > 0) setTimeout(() => processMessageQueue(channelId), PROCESSING_DELAY);
  else messageQueue.delete(channelId);
};

const addToQueue = (channelId, messageData) => {
  if (!messageQueue.has(channelId)) messageQueue.set(channelId, []);
  messageQueue.get(channelId).push(messageData);
  if (messageQueue.get(channelId).length === 1) processMessageQueue(channelId);
};

const getWebhook = async channel => {
  if (webhookCache.has(channel.id)) {
    const cached = webhookCache.get(channel.id);
    cached.timestamp = Date.now();
    return cached.webhook;
  }
  if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageWebhooks)) return null;
  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(w => w.owner.id === client.user.id);
    if (!webhook) {
      webhook = await channel.createWebhook({ name: 'Interserveur Relay', reason: 'Relais inter-serveurs' });
      stats.increment('webhooksCreated');
    }
    const webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
    webhookCache.set(channel.id, { webhook: webhookClient, timestamp: Date.now() });
    return webhookClient;
  } catch (err) {
    logger.error(`Erreur webhook ${channel.id}`, err);
    stats.increment('errors');
    return null;
  }
};

const loadData = async () => {
  connectedChannels.clear();
  const guilds = db.prepare('SELECT * FROM guilds').all();
  for (const { guild_id, channel_id } of guilds) {
    connectedChannels.set(guild_id, { channelId: channel_id, timestamp: Date.now() });
  }
  logger.database('Données chargées depuis SQLite');
};

const saveData = async (immediate = false) => {
  if (saveData.timeout && !immediate) clearTimeout(saveData.timeout);
  const performSave = async () => {
    try {
      const transaction = db.transaction(() => {
        db.prepare('DELETE FROM guilds').run();
        const insertGuild = db.prepare('INSERT OR REPLACE INTO guilds (guild_id, channel_id) VALUES (?, ?)');
        for (const [guildId, { channelId }] of connectedChannels.entries()) {
          if (client.guilds.cache.has(guildId)) insertGuild.run(guildId, channelId);
        }
      });
      transaction();
      logger.database('Données sauvegardées dans SQLite');
    } catch (error) {
      logger.error('Erreur sauvegarde SQLite', error);
      stats.increment('errors');
    }
  };
  if (immediate) await performSave();
  else saveData.timeout = setTimeout(performSave, 1000);
};

const checkConnectionsHealth = async () => {
  logger.info('Vérification santé connexions...');
  let cleanedCount = 0;
  for (const [guildId, guildData] of connectedChannels.entries()) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      connectedChannels.delete(guildId);
      cleanedCount++;
      continue;
    }
    const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
    if (!channel || !channel.permissionsFor(client.user).has(['ViewChannel', 'SendMessages'])) continue;
  }
  if (cleanedCount > 0) await saveData(true);
  logger.success('Vérification terminée');
};

setInterval(() => {
  const now = Date.now();
  for (const [id, { timestamp }] of relayMap) if (now - timestamp > RELAY_MAP_TTL) relayMap.delete(id);
  for (const [channelId, { timestamp }] of webhookCache) if (now - timestamp > WEBHOOK_CACHE_TTL) webhookCache.delete(channelId);
  for (const [guildId, { timestamp }] of connectedChannels) if (now - timestamp > CONNECTED_CHANNELS_TTL) connectedChannels.delete(guildId);
}, 60 * 60 * 1000);

setInterval(() => saveData(), SAVE_INTERVAL);
setInterval(checkConnectionsHealth, HEALTH_CHECK_INTERVAL);
setInterval(() => stats.printStats(), 60 * 60 * 1000);

const updateActivity = () => client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });

const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer le réseau inter-serveurs')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addSubcommand(subcommand => subcommand.setName('config').setDescription('Configurer le salon inter-serveur'))
    .addSubcommand(subcommand => subcommand.setName('statut').setDescription('Vérifier le statut du réseau'))
    .addSubcommand(subcommand => subcommand.setName('diagnostic').setDescription('Afficher les statistiques du bot'))
].map(cmd => cmd.toJSON());

client.on('guildCreate', guild => {
  logger.success(`Nouveau serveur: ${guild.name}`);
  updateActivity();
});

client.on('guildDelete', guild => {
  logger.warn(`Serveur quitté: ${guild.name}`);
  connectedChannels.delete(guild.id);
  saveData();
  updateActivity();
});

client.on('clientReady', async () => {
  console.log(green('🚀 Bot démarré !'));
  await loadData();
  updateActivity();
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  logger.success('Commandes enregistrées');
  stats.printStats();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'interserveur') return;
  stats.increment('commandsExecuted');
  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const guildData = connectedChannels.get(guildId);

  // Vérifier si la commande (sauf config) est exécutée dans le salon configuré
  if (subcommand !== 'config' && guildData && channelId !== guildData.channelId) {
    return interaction.editReply({ content: LANGUAGES.fr.wrong_channel });
  }

  if (subcommand === 'config') {
    connectedChannels.set(guildId, { channelId, timestamp: Date.now() });
    await saveData();
    return interaction.editReply({ content: LANGUAGES.fr.connected.replace('{channel}', interaction.channel.name) });
  } else if (subcommand === 'statut') {
    if (!guildData) return interaction.editReply({ content: LANGUAGES.fr.unconfigured });
    const embed = new EmbedBuilder()
      .setTitle('📊 Statut Réseau')
      .setColor('#00AAFF')
      .addFields(
        { name: '🔄 Salon', value: `<#${guildData.channelId}>`, inline: true },
        { name: '🏠 Serveurs Connectés', value: `${connectedChannels.size}`, inline: true }
      );
    return interaction.editReply({ embeds: [embed] });
  } else if (subcommand === 'diagnostic') {
    const summary = stats.getSummary();
    const embed = new EmbedBuilder()
      .setTitle('📊 STATISTIQUES DU BOT INTERSERVEUR')
      .setColor('#00AAFF')
      .addFields(
        { name: '🕒 Uptime', value: summary.uptime, inline: true },
        { name: '🏠 Serveurs', value: `${summary.servers}`, inline: true },
        { name: '🔗 Canaux connectés', value: `${summary.connectedChannels}`, inline: true },
        { name: '📨 Messages envoyés', value: `${summary.messagesSent}`, inline: true },
        { name: '📩 Messages reçus', value: `${summary.messagesReceived}`, inline: true },
        { name: '⚡ Commandes exécutées', value: `${summary.commandsExecuted}`, inline: true },
        { name: '🪝 Webhooks créés', value: `${summary.webhooksCreated}`, inline: true },
        { name: '🗺️ Relay Map', value: `${summary.relayMapSize}`, inline: true },
        { name: '💾 Webhook Cache', value: `${summary.webhookCacheSize}`, inline: true },
        { name: '📋 Files d\'attente', value: `${summary.messageQueues}`, inline: true },
        { name: '❌ Erreurs', value: summary.errors > 0 ? `**${summary.errors}**` : '0', inline: true },
        { name: '💾 Mémoire', value: summary.memoryUsage, inline: true }
      )
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  stats.increment('messagesReceived');
  const guildId = message.guildId;
  const guildData = connectedChannels.get(guildId);
  if (!guildData || message.channelId !== guildData.channelId) return;
  if (!checkRateLimit(message.author.id, 'message', 10, 60000)) return message.reply(LANGUAGES.fr.rate_limited);
  const content = await resolveMentions(message.content || '', message.guild);
  const files = Array.from(message.attachments.values()).filter(att => att.size <= MAX_FILE_SIZE).map(att => att.url);
  const embeds = message.embeds.filter(e => e.image?.url).map(e => ({ url: e.image.url }));
  const guildName = message.guild?.name || 'Inconnu';
  const targetChannels = Array.from(connectedChannels.values()).map(data => data.channelId).filter(id => id !== message.channelId);
  for (const channelId of targetChannels) {
    addToQueue(channelId, {
      content: content,
      username: `${message.author.username} (${guildName})`,
      avatarURL: message.author.displayAvatarURL(),
      files: files,
      originalId: message.id,
      originalChannelId: message.channelId
    });
    for (const { url } of embeds) {
      addToQueue(channelId, {
        content: '',
        username: `${message.author.username} (${guildName})`,
        avatarURL: message.author.displayAvatarURL(),
        files: [url],
        originalId: message.id,
        originalChannelId: message.channelId
      });
    }
  }
});

const handleExit = signal => {
  logger.system(`Arrêt (${signal})`);
  saveData(true);
  db.close();
  client.destroy();
  process.exit(0);
};
process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
