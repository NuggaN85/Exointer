'use strict';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ActivityType, PermissionsBitField, WebhookClient, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
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
const connectedChannels = new Map();
const frequencyCreators = new Map();
const relayMap = new Map();
const bannedUsers = new Set();
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes

const LANGUAGES = {
  fr: {
    connected: '🔗 Salon connecté à **{frequency}** : {guild} ({channel})',
    disconnected: '🔌 Salon déconnecté de **{frequency}** : {guild} ({channel})',
    banned: '🚫 Utilisateur banni de **{frequency}**',
    no_frequency: '⚠️ Ce salon n\'est lié à aucune fréquence.',
    invalid_frequency: '❌ Fréquence invalide.',
    already_generated: '⚠️ Ce serveur a déjà généré une fréquence. Utilisez `/interserveur gerer` pour voir votre fréquence.'
  }
};

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS channels (
    frequency TEXT,
    channel_id TEXT,
    guild_id TEXT,
    is_creator BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (frequency, channel_id)
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    action TEXT,
    details TEXT
  );
  CREATE TABLE IF NOT EXISTS banned_users (
    frequency TEXT,
    user_id TEXT,
    PRIMARY KEY (frequency, user_id)
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
    frequencyCreators.clear();
    bannedUsers.clear();
    const channels = db.prepare('SELECT frequency, channel_id FROM channels').all();
    for (const { frequency, channel_id } of channels) {
      if (!connectedChannels.has(frequency)) connectedChannels.set(frequency, new Set());
      connectedChannels.get(frequency).add(channel_id);
    }
    const creators = db.prepare('SELECT frequency, channel_id FROM channels WHERE is_creator = 1').all();
    for (const { frequency, channel_id } of creators) {
      frequencyCreators.set(frequency, channel_id);
    }
    // Handle migration: set first channel as creator if none
    for (const [frequency, channels] of connectedChannels.entries()) {
      if (!frequencyCreators.has(frequency) && channels.size > 0) {
        const firstChannelId = [...channels][0];
        frequencyCreators.set(frequency, firstChannelId);
        db.prepare('UPDATE channels SET is_creator = 1 WHERE frequency = ? AND channel_id = ?').run(frequency, firstChannelId);
      }
    }
    const bans = db.prepare('SELECT frequency, user_id FROM banned_users').all();
    for (const { frequency, user_id } of bans) {
      bannedUsers.add(`${frequency}:${user_id}`);
    }
    console.log('📂 Données chargées depuis SQLite');
  } catch (error) {
    console.error('❌ Erreur chargement SQLite:', error.message);
  }
};

const saveData = async () => {
  try {
    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM channels').run();
      const insertChannel = db.prepare('INSERT OR REPLACE INTO channels (frequency, channel_id, guild_id, is_creator) VALUES (?, ?, ?, ?)');
      for (const [frequency, channels] of connectedChannels) {
        const creatorId = frequencyCreators.get(frequency);
        for (const channelId of channels) {
          const channel = client.channels.cache.get(channelId);
          insertChannel.run(frequency, channelId, channel?.guild?.id || 'Inconnu', channelId === creatorId ? 1 : 0);
        }
      }
    });
    transaction();
    console.log('💾 Données sauvegardées dans SQLite');
  } catch (error) {
    console.error('❌ Erreur sauvegarde SQLite:', error);
  }
};

const logAction = async (action, details) => {
  try {
    db.prepare('INSERT INTO logs (timestamp, action, details) VALUES (?, ?, ?)').run(new Date().toISOString(), action, JSON.stringify(details));
  } catch (error) {
    console.error('❌ Erreur sauvegarde log:', error);
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
    .addSubcommand(subcommand => subcommand.setName('generer').setDescription('Générer une fréquence publique'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('lier')
        .setDescription('Lier ce salon à une fréquence')
        .addStringOption(option => option.setName('frequence').setDescription('La fréquence à lier').setRequired(true))
    )
    .addSubcommand(subcommand => subcommand.setName('gerer').setDescription('Voir la fréquence du salon'))
    .addSubcommand(subcommand => subcommand.setName('delier').setDescription('Délier ce salon'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('ban')
        .setDescription('Bannir un utilisateur d\'une fréquence')
        .addUserOption(option => option.setName('utilisateur').setDescription('Utilisateur à bannir').setRequired(true))
        .addStringOption(option => option.setName('frequence').setDescription('Fréquence cible').setRequired(true))
    ),
  new SlashCommandBuilder()
    .setName('listefrequences')
    .setDescription('Liste les fréquences avec le nom du serveur et le nombre de serveurs liés')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
].map(cmd => cmd.toJSON());

client.on('guildCreate', updateActivity);
client.on('guildDelete', async guild => {
  updateActivity();
  db.prepare('DELETE FROM channels WHERE guild_id = ?').run(guild.id);
  await loadData();
  await logAction('guildDelete', { guildId: guild.id });
});

client.on('clientReady', async () => {
  console.log(`✅ Connecté en tant que ${client.user.tag}`);
  await loadData();
  updateActivity();
  const guildChannels = new Map();
  for (const channels of connectedChannels.values()) {
    for (const channelId of channels) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel && !guildChannels.has(channel.guildId)) guildChannels.set(channel.guildId, channel);
    }
  }
  for (const channel of guildChannels.values()) {
    if (channel.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
      const embed = new EmbedBuilder()
        .setTitle('🤖 Bot en ligne')
        .setDescription('Prêt à relayer les messages entre serveurs. Utilisez `/interserveur` pour gérer.')
        .setThumbnail(channel.guild.iconURL({ dynamic: true }) || null)
        .addFields(
          { name: '🏠 Serveurs', value: `${client.guilds.cache.size}`, inline: true },
          { name: '👥 Utilisateurs', value: `${client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0)}`, inline: true }
        )
        .setColor('#99FF99')
        .setTimestamp();
      await channel.send({ embeds: [embed] }).catch(err => console.error(`❌ Erreur envoi embed canal ${channel.id}:`, err.message));
    }
  }
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('📡 Commandes enregistrées');
  } catch (error) {
    console.error('❌ Erreur commandes:', error);
  }
});

const ITEMS_PER_PAGE = 8;

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand() || interaction.replied || interaction.deferred) return;
  if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return interaction.reply({ content: '❌ Permission "Gérer les salons" requise.', ephemeral: true }).catch(() => {});
  }
  await interaction.deferReply({ ephemeral: true }).catch(err => console.error('❌ Erreur deferReply:', err.message));
  try {
    const commandName = interaction.commandName;
    if (commandName === 'interserveur') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'generer') {
        const existingFrequency = [...connectedChannels.entries()].find(([_, channels]) => 
          [...channels].some(channelId => {
            const channel = client.channels.cache.get(channelId);
            return channel?.guildId === interaction.guildId;
          })
        );
        if (existingFrequency) {
          return interaction.editReply({ content: LANGUAGES.fr.already_generated });
        }
        const frequency = uuidv4().slice(0, 8);
        connectedChannels.set(frequency, new Set([interaction.channelId]));
        frequencyCreators.set(frequency, interaction.channelId);
        db.prepare('INSERT INTO channels (frequency, channel_id, guild_id, is_creator) VALUES (?, ?, ?, ?)').run(
          frequency, 
          interaction.channelId, 
          interaction.guildId,
          1
        );
        await saveData();
        await interaction.editReply({ content: `📡 Fréquence générée : **${frequency}**` });
        await logAction('generate', { frequency, channel: interaction.channelId, guild: interaction.guildId });
      }
      if (subcommand === 'lier') {
        const frequency = interaction.options.getString('frequence');
        const channelSet = connectedChannels.get(frequency);
        if (!channelSet) return interaction.editReply({ content: LANGUAGES.fr.invalid_frequency });
        if (channelSet.has(interaction.channelId)) return interaction.editReply({ content: '⚠️ Salon déjà lié.' });
        channelSet.add(interaction.channelId);
        db.prepare('INSERT INTO channels (frequency, channel_id, guild_id, is_creator) VALUES (?, ?, ?, ?)').run(
          frequency, 
          interaction.channelId, 
          interaction.guildId,
          0
        );
        await saveData();
        await interaction.editReply({ content: `🔗 Salon lié à **${frequency}**.` });
        const content = LANGUAGES.fr.connected.replace('{frequency}', frequency).replace('{guild}', interaction.guild.name).replace('{channel}', interaction.channel.name);
        await Promise.all([...channelSet].map(async channelId => {
          if (channelId !== interaction.channelId) {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel?.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
              await channel.send({ content }).catch(err => console.error(`❌ Erreur envoi message canal ${channelId}:`, err.message));
            }
          }
        }));
        await logAction('link', { frequency, channel: interaction.channelId, guild: interaction.guildId });
      }
      if (subcommand === 'gerer') {
        const frequency = [...connectedChannels.entries()].find(([_, v]) => v.has(interaction.channelId))?.[0];
        if (!frequency) return interaction.editReply({ content: LANGUAGES.fr.no_frequency });
        await interaction.editReply({ content: `📡 Fréquence : **${frequency}**` });
      }
      if (subcommand === 'delier') {
        let found = false;
        for (const [frequency, channels] of connectedChannels) {
          if (channels.has(interaction.channelId)) {
            found = true;
            channels.delete(interaction.channelId);
            db.prepare('DELETE FROM channels WHERE frequency = ? AND channel_id = ?').run(frequency, interaction.channelId);
            await interaction.editReply({ content: `🔌 Délié de **${frequency}**` });
            const content = LANGUAGES.fr.disconnected.replace('{frequency}', frequency).replace('{guild}', interaction.guild.name).replace('{channel}', interaction.channel.name);
            await Promise.all([...channels].map(async channelId => {
              const channel = await client.channels.fetch(channelId).catch(() => null);
              if (channel?.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
                await channel.send({ content }).catch(err => console.error(`❌ Erreur envoi message canal ${channelId}:`, err.message));
              }
            }));
            if (channels.size === 0) {
              connectedChannels.delete(frequency);
              frequencyCreators.delete(frequency);
            }
            await saveData();
            await logAction('unlink', { frequency, channel: interaction.channelId, guild: interaction.guildId });
            break;
          }
        }
        if (!found) await interaction.editReply({ content: LANGUAGES.fr.no_frequency });
      }
      if (subcommand === 'ban') {
        const user = interaction.options.getUser('utilisateur');
        const frequency = interaction.options.getString('frequence');
        if (!connectedChannels.has(frequency)) return interaction.editReply({ content: LANGUAGES.fr.invalid_frequency });
        bannedUsers.add(`${frequency}:${user.id}`);
        db.prepare('INSERT OR IGNORE INTO banned_users (frequency, user_id) VALUES (?, ?)').run(frequency, user.id);
        await interaction.editReply({ content: LANGUAGES.fr.banned.replace('{frequency}', frequency) });
        await logAction('ban', { frequency, user: user.id, guild: interaction.guildId });
      }
    } else if (commandName === 'listefrequences') {
      const frequencies = [...connectedChannels.entries()]
        .map(([freq, channels]) => {
          const creatorChannelId = frequencyCreators.get(freq);
          const channel = creatorChannelId ? client.channels.cache.get(creatorChannelId) : null;
          const serverName = channel?.guild?.name || 'Serveur Inconnu';
          
          return {
            frequency: freq,
            serverName: serverName,
            serverCount: channels.size
          };
        })
        .sort((a, b) => b.serverCount - a.serverCount);

      const totalPages = Math.ceil(frequencies.length / ITEMS_PER_PAGE);
      let page = 0;

      const generateEmbed = (pageNum) => {
        const start = pageNum * ITEMS_PER_PAGE;
        const pageItems = frequencies.slice(start, start + ITEMS_PER_PAGE);
        
        const embed = new EmbedBuilder()
          .setTitle('📡 LISTE DES FRÉQUENCES INTER-SERVEURS')
          .setDescription(`**${frequencies.length}** fréquences actives • **${frequencies.reduce((acc, item) => acc + item.serverCount, 0)}** connexions totales`)
          .setColor('#0099FF')
          .setFooter({ 
            text: `Page ${pageNum + 1}/${totalPages} • ${client.guilds.cache.size} serveurs connectés`,
            iconURL: client.user.displayAvatarURL()
          })
          .setTimestamp();

        if (pageItems.length > 0) {
          embed.addFields({
            name: '📊 FRÉQUENCES ACTIVES',
            value: pageItems.map(item => 
              `**${item.frequency}** - ${item.serverName}\n└── 🔗 ${item.serverCount} serveur${item.serverCount > 1 ? 's' : ''} connecté${item.serverCount > 1 ? 's' : ''}`
            ).join('\n\n')
          });
        } else {
          embed.setDescription('🔍 Aucune fréquence active trouvée.\nUtilisez `/interserveur generer` pour créer une nouvelle fréquence.');
        }

        return embed;
      };

      const generateButtons = (pageNum) => {
        return new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId('prev_page')
              .setLabel('◄ Précédent')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(pageNum === 0),
            new ButtonBuilder()
              .setCustomId('page_info')
              .setLabel(`Page ${pageNum + 1}/${totalPages}`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId('next_page')
              .setLabel('Suivant ►')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(pageNum === totalPages - 1)
          );
      };

      const message = await interaction.editReply({
        embeds: [generateEmbed(page)],
        components: totalPages > 1 ? [generateButtons(page)] : []
      });

      if (totalPages > 1) {
        const collector = message.createMessageComponentCollector({ 
          filter: i => i.user.id === interaction.user.id,
          time: 120000 
        });

        collector.on('collect', async i => {
          if (i.customId === 'prev_page' && page > 0) page--;
          if (i.customId === 'next_page' && page < totalPages - 1) page++;
          
          await i.update({
            embeds: [generateEmbed(page)],
            components: [generateButtons(page)]
          });
        });

        collector.on('end', () => {
          interaction.editReply({ 
            components: [] 
          }).catch(() => {});
        });
      }
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
  const frequency = [...connectedChannels.entries()].find(([_, v]) => v.has(message.channelId))?.[0];
  if (!frequency || bannedUsers.has(`${frequency}:${message.author.id}`)) return;
  const channels = connectedChannels.get(frequency);
  if (!channels || !channels.size) return;
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
  
  await Promise.all([...channels].map(async channelId => {
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
  const frequency = [...connectedChannels.entries()].find(([_, v]) => v.has(message.channelId))?.[0];
  if (!frequency) return;
  const channels = connectedChannels.get(frequency);
  await Promise.all([...channels].map(async channelId => {
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
  const frequency = [...connectedChannels.entries()].find(([_, v]) => v.has(message.channelId))?.[0];
  if (!frequency) return;
  const channels = connectedChannels.get(frequency);
  await Promise.all([...channels].map(async channelId => {
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
