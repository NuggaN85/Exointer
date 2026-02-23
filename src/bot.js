'use strict';

const { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType, PermissionsBitField, WebhookClient, EmbedBuilder, ActionRowBuilder, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, Events, ButtonBuilder, ButtonStyle } = require('discord.js');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

// ─── Validation de l'environnement ───────────────────────────────────────────
if (!process.env.DISCORD_TOKEN || !process.env.CLIENT_ID) {
  console.error('⚠️ DISCORD_TOKEN et CLIENT_ID requis.');
  process.exit(1);
}

// ─── Client Discord ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.User,
    Partials.Reaction,
  ],
  rest: {
    timeout: 30000,
    retries: 3,
  },
  shards: 'auto',
});

// ─── Base de données SQLite ───────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'interservers.db'));
    // Configuration pragma optimisée
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('temp_store = MEMORY');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT
  );
`);

// ─── State en mémoire ─────────────────────────────────────────────────────────
const connectedChannels = new Map();
const relayMap = new Map();
const reverseRelayMap = new Map();
const webhookCache = new Map(); 
const webhookQueues = new Map(); 

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24 h
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 min

// ─── Traductions ──────────────────────────────────────────────────────────────
const LANG = {
  config_success:    '✅ Configuration réussie ! Ce salon est maintenant connecté au réseau inter-serveurs.',
  already_connected: '⚠️ Ce salon est déjà connecté au réseau inter-serveurs.',
  not_connected:     '❌ Ce serveur n\'est pas connecté au réseau inter-serveurs.',
  disconnected:      '🔓 Salon déconnecté du réseau inter-serveurs.',
  missing_access:    '⚠️ Accès manquant au canal {channelId} sur le serveur {guildName}.',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const encodeMentions = async (content) => {
  if (!content) return '';
  // Bloquer @everyone / @here
  let result = content.replace(/@(everyone|here)/g, '@\u200b$1');
  const mentionRegex = /<@!?(\d{17,20})>/g;
  const matches = [...result.matchAll(mentionRegex)];
  for (const match of matches) {
    try {
      const user = await client.users.fetch(match[1]);
      result = result.replace(match[0], `@${user.username}`);
    } catch { /* utilisateur introuvable, on laisse tel quel */ }
  }
  return result;
};

// ─── Persistence ──────────────────────────────────────────────────────────────
const saveData = () => {
  try {
    db.transaction(() => {
      db.prepare('DELETE FROM guilds').run();
      const insert = db.prepare('INSERT OR REPLACE INTO guilds (guild_id, channel_id) VALUES (?, ?)');
      for (const [guildId, channelId] of connectedChannels) {
        insert.run(guildId, channelId);
      }
    })();
    console.log('💾 Données sauvegardées dans SQLite');
  } catch (err) {
    console.error('❌ Erreur sauvegarde SQLite:', err);
  }
};

const loadData = () => {
  try {
    connectedChannels.clear();
    for (const { guild_id, channel_id } of db.prepare('SELECT * FROM guilds').all()) {
      connectedChannels.set(guild_id, channel_id);
    }
    console.log('✅ Données chargées depuis SQLite');
  } catch (err) {
    console.error('❌ Erreur chargement SQLite:', err.message);
  }
};

// Nettoyage périodique de la relayMap + reverseRelayMap
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of relayMap.entries()) {
    if (now - entry.timestamp > RELAY_MAP_TTL) {
      // Nettoyer aussi la map inverse
      const reverse = reverseRelayMap.get(entry.originalId);
      if (reverse) {
        const filtered = reverse.filter(r => r.relayedId !== id);
        if (filtered.length === 0) reverseRelayMap.delete(entry.originalId);
        else reverseRelayMap.set(entry.originalId, filtered);
      }
      relayMap.delete(id);
    }
  }
}, 60 * 60 * 1000);

// Sauvegarde périodique
setInterval(saveData, SAVE_INTERVAL);

// ─── Webhook helpers ──────────────────────────────────────────────────────────
const getWebhook = async (channel) => {
  if (!channel.permissionsFor(client.user).has([
    PermissionsBitField.Flags.ManageWebhooks,
    PermissionsBitField.Flags.SendMessages,
  ])) {
    console.warn(`⚠️ Permissions insuffisantes pour webhooks dans ${channel.id} (${channel.guild?.name})`);
    return null;
  }

  // Vérifier le cache
  if (webhookCache.has(channel.id)) {
    return webhookCache.get(channel.id);
  }

  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(w => w.owner?.id === client.user.id);
    if (!webhook) webhook = await channel.createWebhook({ name: 'Interserveur Relay' });
    const wc = new WebhookClient({ id: webhook.id, token: webhook.token });
    webhookCache.set(channel.id, wc);
    return wc;
  } catch (err) {
    console.error(`❌ Erreur création webhook canal ${channel.id}:`, err.message);
    webhookCache.delete(channel.id);
    return null;
  }
};

const enqueueWebhookSend = (channelId, sendFn) => {
  const prev = webhookQueues.get(channelId) || Promise.resolve();
  const next = prev
    .then(() => new Promise(resolve => setTimeout(resolve, 500)))
    .then(sendFn)
    .catch(err => console.error(`❌ File webhook ${channelId}:`, err.message));
  webhookQueues.set(channelId, next);
  next.finally(() => {
    if (webhookQueues.get(channelId) === next) webhookQueues.delete(channelId);
  });
  return next;
};

// ─── Activité ─────────────────────────────────────────────────────────────────
const updateActivity = () => {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
};

// ─── Commandes slash ──────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer la connexion au réseau inter-serveurs')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addSubcommand(sub => sub.setName('config').setDescription('Configurer ce salon'))
    .addSubcommand(sub => sub.setName('deconfig').setDescription('Déconnecter ce salon'))
    .addSubcommand(sub => sub.setName('stats').setDescription('Afficher les statistiques détaillées')),
].map(cmd => cmd.toJSON());

// ─── Envoi relay ──────────────────────────────────────────────────────────────
const sendRelay = async ({ channel, content, username, avatarURL, originalGuild, files = [], replyEmbed }) => {
  if (!channel?.isTextBased() || !channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
    console.warn(LANG.missing_access.replace('{channelId}', channel.id).replace('{guildName}', channel.guild?.name || 'Inconnu'));
    return null;
  }

  const webhook = await getWebhook(channel);
  if (!webhook) return null;

  return enqueueWebhookSend(channel.id, async () => {
    try {
      const displayUsername = `${username} [${originalGuild.name}]`;
      const payload = {
        username: displayUsername,
        avatarURL,
        allowedMentions: { parse: [] }, 
      };

      if (content) payload.content = content;
      if (files.length) payload.files = files;
      if (replyEmbed) payload.embeds = [replyEmbed];

      const sent = await webhook.send(payload);
      return sent;
    } catch (err) {
      console.error(`❌ Erreur webhook canal ${channel.id}:`, err.message);
      if (err.status === 404 || err.code === 10015) {
        webhookCache.delete(channel.id);
      }
      return null;
    }
  });
};

const registerRelay = (sentId, originalId, originalChannelId, originalGuildId, relayedChannelId) => {
  relayMap.set(sentId, {
    originalId,
    originalChannelId,
    originalGuildId,
    timestamp: Date.now(),
  });
  const existing = reverseRelayMap.get(originalId) || [];
  existing.push({ relayedId: sentId, relayedChannelId });
  reverseRelayMap.set(originalId, existing);
};

// ─── Événements client ────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Connecté en tant que ${readyClient.user.tag}`);
  loadData();
  updateActivity();

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commandes slash enregistrées globalement');
  } catch (err) {
    console.error('❌ Erreur enregistrement commandes:', err);
  }
});

client.on(Events.GuildCreate, (guild) => {
  console.log(`➕ Ajouté au serveur: ${guild.name} (ID: ${guild.id})`);
  updateActivity();
});

client.on(Events.GuildDelete, (guild) => {
  console.log(`➖ Retiré du serveur: ${guild.name} (ID: ${guild.id})`);
  connectedChannels.delete(guild.id);
  db.prepare('DELETE FROM guilds WHERE guild_id = ?').run(guild.id);
  saveData();
  updateActivity();
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {

  // ── Commandes slash ────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand()) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: '❌ Permission "Gérer les salons" requise.', ephemeral: true }).catch(() => {});
    }

    await interaction.deferReply({ ephemeral: true }).catch(err => console.error('❌ deferReply:', err.message));

    try {
      const { guildId, channelId } = interaction;
      const sub = interaction.options.getSubcommand();

      // ── /interserveur config ─────────────────────────────────────────────
      if (sub === 'config') {
        if (connectedChannels.has(guildId)) {
          return interaction.editReply({ content: LANG.already_connected });
        }
        connectedChannels.set(guildId, channelId);
        saveData();
        updateActivity();

        const notifEmbed = new EmbedBuilder()
          .setTitle('🆕 Nouveau serveur connecté !')
          .setDescription(`**${interaction.guild.name}** a rejoint le réseau inter-serveurs.`)
          .setColor(0x00FF7F)
          .setTimestamp()
          .setFooter({ text: 'Réseau Inter-Serveurs', iconURL: client.user.displayAvatarURL() });

        await Promise.allSettled(
          [...connectedChannels.entries()]
            .filter(([id]) => id !== guildId)
            .map(async ([, chId]) => {
              const ch = await client.channels.fetch(chId).catch(() => null);
              if (ch?.isTextBased() && ch.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
                await ch.send({ embeds: [notifEmbed] }).catch(err => console.error(`❌ Notification ${chId}:`, err.message));
              }
            })
        );
        return interaction.editReply({ content: LANG.config_success });
      }

      // ── /interserveur deconfig ───────────────────────────────────────────
      if (sub === 'deconfig') {
        if (!connectedChannels.has(guildId)) {
          return interaction.editReply({ content: LANG.not_connected });
        }
        connectedChannels.delete(guildId);
        saveData();
        updateActivity();
        return interaction.editReply({ content: LANG.disconnected });
      }

      // ── /interserveur stats ──────────────────────────────────────────────
      if (sub === 'stats') {
        let totalMembers = 0;
        const serverDetails = [];

        for (const [gId, chId] of connectedChannels) {
          const guild = client.guilds.cache.get(gId);
          if (!guild) continue;
          totalMembers += guild.memberCount;
          const ch = guild.channels.cache.get(chId);
          serverDetails.push({
            name: guild.name,
            memberCount: guild.memberCount,
            channel: ch ? `#${ch.name}` : `Salon inconnu (${chId})`,
            guildId: gId,
          });
        }
        serverDetails.sort((a, b) => b.memberCount - a.memberCount);

        const statsEmbed = new EmbedBuilder()
          .setTitle('🌐 Statistiques du Réseau Inter-Serveurs')
          .setDescription('Découvrez les serveurs connectés et leurs statistiques.')
          .setColor(0x5865F2)
          .setTimestamp()
          .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
          .addFields(
            { name: '📊 Serveurs Connectés', value: `\`\`\`fix\n${connectedChannels.size} serveurs\n\`\`\``, inline: false },
            { name: '👥 Membres Totaux',     value: `\`\`\`fix\n${totalMembers.toLocaleString()} membres\n\`\`\``, inline: false },
            { name: '🔗 Canaux Actifs',       value: `\`\`\`fix\n${serverDetails.length} canaux\n\`\`\``, inline: false },
            { name: '💡 Instructions',        value: '> Utilisez le menu ci-dessous pour voir les détails d\'un serveur spécifique.', inline: false }
          )
          .setFooter({ text: `Demandé par ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        if (serverDetails.length === 0) {
          statsEmbed.addFields({ name: '🏆 Serveurs Connectés', value: '```\n🥺 Aucun serveur connecté pour le moment.\n```' });
          return interaction.editReply({ embeds: [statsEmbed] });
        }

        const select = new StringSelectMenuBuilder()
          .setCustomId('select_server')
          .setPlaceholder('🔍 Sélectionnez un serveur pour plus de détails')
          .addOptions(
            serverDetails.slice(0, 25).map(s =>
              new StringSelectMenuOptionBuilder()
                .setLabel(s.name)
                .setDescription(`👥 ${s.memberCount.toLocaleString()} membres`)
                .setValue(s.guildId)
                .setEmoji('🏠')
            )
          );

        return interaction.editReply({
          embeds: [statsEmbed],
          components: [new ActionRowBuilder().addComponents(select)],
        });
      }
    } catch (err) {
      console.error('❌ Erreur interaction slash:', err.message);
      await interaction.editReply({ content: '❌ Une erreur est survenue.' }).catch(() => {});
    }
  }

  // ── Select menu : détails d'un serveur ────────────────────────────────────
  else if (interaction.isStringSelectMenu() && interaction.customId === 'select_server') {
    await interaction.deferReply({ ephemeral: true }).catch(err => console.error('❌ deferReply:', err.message));
    try {
      const selectedGuildId = interaction.values[0];
      const guild = client.guilds.cache.get(selectedGuildId);
      if (!guild) return interaction.editReply({ content: '❌ Serveur non trouvé.' });

      const chId = connectedChannels.get(selectedGuildId);
      const ch = guild.channels.cache.get(chId);
      const owner = await guild.fetchOwner();
      const createdAt = guild.createdAt.toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' });

      let inviteButton = null;
      if (ch && ch.permissionsFor(client.user).has(PermissionsBitField.Flags.CreateInstantInvite)) {
        try {
          const invite = await ch.createInvite({ maxAge: 86400, maxUses: 0 });
          inviteButton = new ButtonBuilder()
            .setLabel('Rejoindre le serveur')
            .setStyle(ButtonStyle.Link)
            .setURL(invite.url)
            .setEmoji('🚪');
        } catch (err) {
          console.error(`❌ Erreur création invite ${chId}:`, err.message);
        }
      }

      const detailEmbed = new EmbedBuilder()
        .setTitle(guild.name)
        .setDescription('> Informations détaillées sur ce serveur du réseau inter-serveurs')
        .setColor(0x5865F2)
        .setThumbnail(guild.iconURL({ size: 256 }) || client.user.displayAvatarURL())
        .setTimestamp()
        .addFields(
          { name: '👥 Nombre de membres', value: `\`\`\`fix\n${guild.memberCount.toLocaleString()}\n\`\`\``, inline: false },
          { name: '🔗 Canal connecté',     value: `\`\`\`fix\n${ch ? `#${ch.name}` : `Salon inconnu (${chId})`}\n\`\`\``, inline: false },
          { name: '🆔 ID du serveur',       value: `\`\`\`fix\n${guild.id}\n\`\`\``, inline: false },
          { name: '📅 Date de création',    value: `\`\`\`fix\n${createdAt}\n\`\`\``, inline: false },
          { name: '👑 Propriétaire',        value: `<@${owner.user.id}>\n\`${owner.user.username}\``, inline: false }
        )
        .setFooter({ text: `Consulté par ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

      const components = inviteButton
        ? [new ActionRowBuilder().addComponents(inviteButton)]
        : [];

      return interaction.editReply({ embeds: [detailEmbed], components });
    } catch (err) {
      console.error('❌ Erreur select menu:', err.message);
      await interaction.editReply({ content: '❌ Une erreur est survenue.' }).catch(() => {});
    }
  }
});

// ─── Relai des messages ───────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildId = message.guildId;
  const connectedChannelId = connectedChannels.get(guildId);
  if (!connectedChannelId || message.channelId !== connectedChannelId) return;

  // Stickers non supportés → suppression
  if (message.stickers.size > 0) {
    await message.delete().catch(err => console.error('⚠️ Erreur suppression sticker:', err.message));
    return;
  }

  const content = await encodeMentions(message.content || '');
  const files = [...message.attachments.values()]
    .filter(att => att.size <= MAX_FILE_SIZE)
    .map(att => att.url);

  const targets = [...connectedChannels.entries()]
    .filter(([id]) => id !== guildId)
    .map(([, chId]) => chId);

  // ── Réponse à un message ──────────────────────────────────────────────────
  if (message.reference?.messageId) {
    const relayed = relayMap.get(message.reference.messageId);
    if (relayed) {
      const originalChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
      if (!originalChannel) return;
      const originalMessage = await originalChannel.messages.fetch(relayed.originalId).catch(() => null);
      if (!originalMessage) return;

      const originalContent = originalMessage.content
        ? await encodeMentions(originalMessage.content)
        : '*(Message sans texte)*';

      const replyEmbed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({
          name: `↩️ En réponse à ${originalMessage.author.username}`,
          iconURL: originalMessage.author.displayAvatarURL(),
        })
        .setDescription(
          `<@${originalMessage.author.id}>\n` +
          `${originalContent.length > 200 ? originalContent.slice(0, 200) + '…' : originalContent}`
        );

      await Promise.allSettled(targets.map(async (chId) => {
        const channel = await client.channels.fetch(chId).catch(() => null);
        if (!channel) return;
        const sent = await sendRelay({
          channel,
          content,
          username: message.author.username,
          avatarURL: message.author.displayAvatarURL(),
          originalGuild: message.guild,
          files,
          replyEmbed,
        });
        if (sent) {
          registerRelay(sent.id, message.id, message.channelId, guildId, channel.id);
        }
      }));
      return;
    }
  }

  // ── Message normal ────────────────────────────────────────────────────────
  await Promise.allSettled(targets.map(async (chId) => {
    const channel = await client.channels.fetch(chId).catch(() => null);
    if (!channel) return;
    const sent = await sendRelay({
      channel,
      content,
      username: message.author.username,
      avatarURL: message.author.displayAvatarURL(),
      originalGuild: message.guild,
      files,
    });
    if (sent) {
      registerRelay(sent.id, message.id, message.channelId, guildId, channel.id);
    }
  }));
});

// ─── Propagation des réactions ────────────────────────────────────────────────
const propagateReaction = async (message, emoji, action) => {
  const channelId = connectedChannels.get(message.guildId);
  if (!channelId || message.channelId !== channelId) return;

  const emojiKey = emoji.id || emoji.name;

  const applyReaction = async (targetMessage, add) => {
    if (add) {
      await targetMessage.react(emojiKey).catch(err =>
        console.error('❌ Erreur react:', err.message)
      );
    } else {
      const r = targetMessage.reactions.cache.get(emojiKey);
      if (r) {
        await r.users.remove(client.user.id).catch(err =>
          console.error('❌ Erreur remove react:', err.message)
        );
      }
    }
  };

  // Cas 1 : relai → original
  const relayed = relayMap.get(message.id);
  if (relayed) {
    const targetCh = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
    if (!targetCh?.isTextBased()) return;
    const targetMsg = await targetCh.messages.fetch(relayed.originalId).catch(() => null);
    if (targetMsg) await applyReaction(targetMsg, action === 'add');
    return;
  }

  // Cas 2 : original → tous les relais
  const relayedList = reverseRelayMap.get(message.id);
  if (relayedList) {
    await Promise.allSettled(relayedList.map(async ({ relayedId, relayedChannelId }) => {
      const targetCh = await client.channels.fetch(relayedChannelId).catch(() => null);
      if (!targetCh?.isTextBased()) return;
      const targetMsg = await targetCh.messages.fetch(relayedId).catch(() => null);
      if (targetMsg) await applyReaction(targetMsg, action === 'add');
    }));
  }
};

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); }
    catch (err) { console.error('❌ Fetch réaction:', err.message); return; }
  }
  await propagateReaction(reaction.message, reaction.emoji, 'add');
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) {
    try { await reaction.fetch(); }
    catch (err) { console.error('❌ Fetch réaction:', err.message); return; }
  }
  await propagateReaction(reaction.message, reaction.emoji, 'remove');
});

// ─── Fermeture propre ─────────────────────────────────────────────────────────

const handleExit = (signal) => {
  try {
    console.log(`\n${signal} reçu, fermeture en cours...`);
    saveData();
    db.close();
    console.log('💾 Données sauvegardées, base de données fermée.');
    client.destroy();
    console.log('👋 Client Discord déconnecté.');
    process.exit(0);
  } catch (err) {
    console.error(`❌ Erreur fermeture (${signal}):`, err.message);
    process.exit(1);
  }
};

process.on('SIGINT',  () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

// FIX 9 : Ne plus tuer le bot sur toute erreur non gérée — juste logger
process.on('uncaughtException', (err) => {
  console.error('❌ Erreur non capturée:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('❌ Promise rejetée non gérée:', err);
});

// ─── Connexion ────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('❌ Erreur de connexion Discord:', err.message);
  process.exit(1);
});
