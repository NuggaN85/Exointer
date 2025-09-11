'use strict';
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType, PermissionsBitField, WebhookClient, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { randomBytes } from 'crypto';
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
const connectedChannels = new Map(); // guildId -> { channelId, frequencies: Map<freq, {linkedGuilds: Set<guildId>, bannedGuilds: Set<guildId>, key: string|null}> }
const relayMap = new Map();
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24h
const SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const ITEMS_PER_PAGE = 10;

const LANGUAGES = {
  fr: {
    connected: '🔗 Salon connecté : {guild} ({channel})',
    freq_generated: '🔑 Fréquence publique générée : {freq}\nSalon défini : {channel}',
    private_generated: '🔑 Fréquence privée générée : {freq}\nClé d\'accès : {key}\nSalon défini : {channel}',
    linked: '🔗 Lié à la fréquence {freq} du serveur {guild}.',
    unlinked: '🔓 Délié de la fréquence {freq}.',
    managed: '⚙️ Fréquences gérées par ce serveur :\n{freqs}',
    banned: '🚫 Serveur {guild} banni de la fréquence {freq}.',
    unbanned: '✅ Serveur {guild} débanni de la fréquence {freq}.',
    list_freq: '📡 LISTE DES FRÉQUENCES INTER-SERVEURS',
    list_banned: '📜 Serveurs bannis pour la fréquence {freq}',
    no_freq: '🔍 Aucune fréquence trouvée.',
    no_banned: '🔍 Aucun serveur banni pour cette fréquence.',
    invalid_key: '❌ Clé d\'accès incorrecte.',
    missing_access: '⚠️ Accès manquant au canal {channelId} sur le serveur {guildName}.',
    not_owner: '❌ Cette interaction ne vous appartient pas.'
  }
};

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT
  );
  CREATE TABLE IF NOT EXISTS frequencies (
    freq TEXT PRIMARY KEY,
    owner_guild_id TEXT,
    key TEXT
  );
  CREATE TABLE IF NOT EXISTS links (
    freq TEXT,
    linked_guild_id TEXT,
    PRIMARY KEY (freq, linked_guild_id)
  );
  CREATE TABLE IF NOT EXISTS bans (
    freq TEXT,
    banned_guild_id TEXT,
    PRIMARY KEY (freq, banned_guild_id)
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
    const guilds = db.prepare('SELECT * FROM guilds').all();
    for (const { guild_id, channel_id } of guilds) {
      connectedChannels.set(guild_id, { channelId: channel_id, frequencies: new Map() });
    }
    const freqs = db.prepare('SELECT * FROM frequencies').all();
    for (const { freq, owner_guild_id, key } of freqs) {
      const guildData = connectedChannels.get(owner_guild_id);
      if (guildData) {
        guildData.frequencies.set(freq, { linkedGuilds: new Set(), bannedGuilds: new Set(), key: key || null });
      }
    }
    const links = db.prepare('SELECT * FROM links').all();
    for (const { freq, linked_guild_id } of links) {
      const owner = db.prepare('SELECT owner_guild_id FROM frequencies WHERE freq = ?').get(freq);
      if (owner) {
        connectedChannels.get(owner.owner_guild_id)?.frequencies.get(freq)?.linkedGuilds.add(linked_guild_id);
      }
    }
    const bans = db.prepare('SELECT * FROM bans').all();
    for (const { freq, banned_guild_id } of bans) {
      const owner = db.prepare('SELECT owner_guild_id FROM frequencies WHERE freq = ?').get(freq);
      if (owner) {
        connectedChannels.get(owner.owner_guild_id)?.frequencies.get(freq)?.bannedGuilds.add(banned_guild_id);
      }
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
      db.prepare('DELETE FROM frequencies').run();
      db.prepare('DELETE FROM links').run();
      db.prepare('DELETE FROM bans').run();
      const insertGuild = db.prepare('INSERT OR REPLACE INTO guilds (guild_id, channel_id) VALUES (?, ?)');
      const insertFreq = db.prepare('INSERT OR REPLACE INTO frequencies (freq, owner_guild_id, key) VALUES (?, ?, ?)');
      const insertLink = db.prepare('INSERT OR REPLACE INTO links (freq, linked_guild_id) VALUES (?, ?)');
      const insertBan = db.prepare('INSERT OR REPLACE INTO bans (freq, banned_guild_id) VALUES (?, ?)');
      for (const [guildId, { channelId, frequencies }] of connectedChannels) {
        insertGuild.run(guildId, channelId);
        for (const [freq, { linkedGuilds, bannedGuilds, key }] of frequencies) {
          insertFreq.run(freq, guildId, key);
          for (const linked of linkedGuilds) insertLink.run(freq, linked);
          for (const banned of bannedGuilds) insertBan.run(freq, banned);
        }
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
    console.error(`❌ Erreur création webhook pour canal ${channel.id} (serveur ${channel.guild?.name || 'Inconnu'}):`, err.message);
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
        .setName('generer')
        .setDescription('Générer une fréquence et définir ce salon')
        .addStringOption(option =>
          option.setName('type')
            .setDescription('Type de fréquence')
            .setRequired(true)
            .addChoices(
              { name: 'Public', value: 'public' },
              { name: 'Privé', value: 'prive' }
            ))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lier')
        .setDescription('Lier à une fréquence')
        .addStringOption(option => option.setName('freq').setDescription('La fréquence').setRequired(true))
        .addStringOption(option => option.setName('key').setDescription('Clé pour fréquences privées').setRequired(false))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('delier')
        .setDescription('Délié d\'une fréquence')
        .addStringOption(option => option.setName('freq').setDescription('La fréquence').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('gerer')
        .setDescription('Gérer les fréquences de ce serveur')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('ban')
        .setDescription('Bannir un serveur d\'une fréquence')
        .addStringOption(option => option.setName('freq').setDescription('La fréquence').setRequired(true))
        .addStringOption(option => option.setName('guild_id').setDescription('ID du serveur').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('unban')
        .setDescription('Débannir un serveur d\'une fréquence')
        .addStringOption(option => option.setName('freq').setDescription('La fréquence').setRequired(true))
        .addStringOption(option => option.setName('guild_id').setDescription('ID du serveur').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('listebanni')
        .setDescription('Lister les serveurs bannis d\'une fréquence')
        .addStringOption(option => option.setName('freq').setDescription('La fréquence').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('listefrequences')
        .setDescription('Lister toutes les fréquences avec détails')
    )
].map(cmd => cmd.toJSON());

client.on('guildCreate', updateActivity);
client.on('guildDelete', async guild => {
  updateActivity();
  connectedChannels.delete(guild.id);
  const deletes = [
    'DELETE FROM links WHERE linked_guild_id = ?',
    'DELETE FROM bans WHERE banned_guild_id = ?',
    'DELETE FROM links WHERE freq IN (SELECT freq FROM frequencies WHERE owner_guild_id = ?)',
    'DELETE FROM bans WHERE freq IN (SELECT freq FROM frequencies WHERE owner_guild_id = ?)',
    'DELETE FROM frequencies WHERE owner_guild_id = ?',
    'DELETE FROM guilds WHERE guild_id = ?'
  ];
  for (const query of deletes) {
    db.prepare(query).run(guild.id);
  }
  await saveData();
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
  if (interaction.isChatInputCommand()) {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: '❌ Permission "Gérer les salons" requise.', ephemeral: true }).catch(() => {});
    }
    await interaction.deferReply({ ephemeral: true }).catch(err => console.error('❌ Erreur deferReply:', err.message));
    try {
      const guildId = interaction.guildId;
      const subcommand = interaction.options.getSubcommand();
      const channelId = interaction.channelId;
      const channelName = interaction.channel.name;

      if (subcommand === 'generer') {
        const type = interaction.options.getString('type');
        const freq = randomBytes(8).toString('hex');
        const key = type === 'prive' ? randomBytes(16).toString('hex') : null;
        let guildData = connectedChannels.get(guildId);
        if (!guildData) {
          guildData = { channelId, frequencies: new Map() };
          connectedChannels.set(guildId, guildData);
        }
        guildData.frequencies.set(freq, { linkedGuilds: new Set(), bannedGuilds: new Set(), key });
        await saveData();
        if (type === 'public') {
          return interaction.editReply({ content: LANGUAGES.fr.freq_generated.replace('{freq}', freq).replace('{channel}', channelName) });
        } else {
          return interaction.editReply({ content: LANGUAGES.fr.private_generated.replace('{freq}', freq).replace('{key}', key).replace('{channel}', channelName) });
        }
      } else if (!connectedChannels.has(guildId)) {
        return interaction.editReply({ content: '⚠️ Générez d\'abord une fréquence avec /interserveur generer.' });
      }

      const guildData = connectedChannels.get(guildId);
      if (subcommand === 'lier') {
        const freq = interaction.options.getString('freq');
        const key = interaction.options.getString('key');
        const owner = db.prepare('SELECT owner_guild_id, key FROM frequencies WHERE freq = ?').get(freq);
        if (!owner) return interaction.editReply({ content: '⚠️ Fréquence invalide.' });
        const ownerData = connectedChannels.get(owner.owner_guild_id);
        const freqData = ownerData?.frequencies.get(freq);
        if (!freqData) return interaction.editReply({ content: '⚠️ Fréquence invalide.' });
        if (freqData.key && (!key || key !== freqData.key)) return interaction.editReply({ content: LANGUAGES.fr.invalid_key });
        if (freqData.bannedGuilds.has(guildId)) return interaction.editReply({ content: '❌ Accès refusé.' });
        if (freqData.linkedGuilds.has(guildId)) return interaction.editReply({ content: '⚠️ Déjà lié.' });
        if (!guildData.channelId) guildData.channelId = channelId;
        freqData.linkedGuilds.add(guildId);
        await saveData();
        const content = LANGUAGES.fr.connected.replace('{guild}', interaction.guild.name).replace('{channel}', channelName);
        const freqChannels = [ownerData.channelId];
        for (const linkedId of freqData.linkedGuilds) {
          if (linkedId !== guildId) freqChannels.push(connectedChannels.get(linkedId)?.channelId);
        }
        await Promise.allSettled(freqChannels.map(async cId => {
          if (cId) {
            const channel = await client.channels.fetch(cId).catch(() => null);
            if (channel?.isTextBased() && channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
              await channel.send({ content }).catch(err => console.error(`❌ Erreur envoi message canal ${cId} (serveur ${channel.guild?.name || 'Inconnu'}):`, err.message));
            } else {
              console.warn(LANGUAGES.fr.missing_access.replace('{channelId}', cId).replace('{guildName}', channel?.guild?.name || 'Inconnu'));
            }
          }
        }));
        return interaction.editReply({ content: LANGUAGES.fr.linked.replace('{freq}', freq).replace('{guild}', interaction.guild.name) });
      } else if (subcommand === 'delier') {
        const freq = interaction.options.getString('freq');
        const owner = db.prepare('SELECT owner_guild_id FROM frequencies WHERE freq = ?').get(freq);
        if (!owner) return interaction.editReply({ content: '⚠️ Fréquence invalide.' });
        const ownerData = connectedChannels.get(owner.owner_guild_id);
        ownerData?.frequencies.get(freq)?.linkedGuilds.delete(guildId);
        await saveData();
        return interaction.editReply({ content: LANGUAGES.fr.unlinked.replace('{freq}', freq) });
      } else if (subcommand === 'gerer') {
        if (guildData.frequencies.size === 0) return interaction.editReply({ content: LANGUAGES.fr.no_freq });
        const freqsList = Array.from(guildData.frequencies.entries()).map(([freq, data]) => {
          return data.key 
            ? `**${freq}** (Privée, Clé: ${data.key})`
            : `**${freq}** (Publique)`;
        }).join('\n');
        const embed = new EmbedBuilder()
          .setTitle(LANGUAGES.fr.managed.split('\n')[0])
          .setDescription(freqsList || LANGUAGES.fr.no_freq)
          .setColor('#00AAFF')
          .setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      } else if (subcommand === 'ban') {
        const freq = interaction.options.getString('freq');
        const banGuildId = interaction.options.getString('guild_id');
        if (!guildData.frequencies.has(freq)) return interaction.editReply({ content: '⚠️ Vous ne possédez pas cette fréquence.' });
        const freqData = guildData.frequencies.get(freq);
        freqData.bannedGuilds.add(banGuildId);
        freqData.linkedGuilds.delete(banGuildId);
        await saveData();
        return interaction.editReply({ content: LANGUAGES.fr.banned.replace('{freq}', freq).replace('{guild}', banGuildId) });
      } else if (subcommand === 'unban') {
        const freq = interaction.options.getString('freq');
        const unbanGuildId = interaction.options.getString('guild_id');
        if (!guildData.frequencies.has(freq)) return interaction.editReply({ content: '⚠️ Vous ne possédez pas cette fréquence.' });
        const freqData = guildData.frequencies.get(freq);
        if (!freqData.bannedGuilds.has(unbanGuildId)) return interaction.editReply({ content: '⚠️ Ce serveur n\'est pas banni.' });
        freqData.bannedGuilds.delete(unbanGuildId);
        await saveData();
        return interaction.editReply({ content: LANGUAGES.fr.unbanned.replace('{freq}', freq).replace('{guild}', unbanGuildId) });
      } else if (subcommand === 'listebanni') {
        const freq = interaction.options.getString('freq');
        if (!guildData.frequencies.has(freq)) return interaction.editReply({ content: '⚠️ Vous ne possédez pas cette fréquence.' });
        const freqData = guildData.frequencies.get(freq);
        const bannedList = Array.from(freqData.bannedGuilds).map(guildId => {
          const guild = client.guilds.cache.get(guildId);
          return guild ? `**${guild.name}** (${guildId})` : `**Inconnu** (${guildId})`;
        }).join('\n') || LANGUAGES.fr.no_banned;
        
        // Changer la couleur en rouge pastel (#FF6B6B)
        const embed = new EmbedBuilder()
          .setTitle(LANGUAGES.fr.list_banned.replace('{freq}', freq))
          .setDescription(bannedList)
          .setColor('#FF6B6B')
          .setTimestamp();
        
        return interaction.editReply({ embeds: [embed] });
      } else if (subcommand === 'listefrequences') {
        const frequencies = [...connectedChannels.entries()]
          .map(([guildId, { frequencies }]) => {
            return [...frequencies.entries()].map(([freq, { linkedGuilds }]) => ({
              frequency: freq,
              serverName: client.guilds.cache.get(guildId)?.name || 'Inconnu',
              serverCount: linkedGuilds.size
            }));
          })
          .flat()
          .sort((a, b) => b.serverCount - a.serverCount);

        const totalPages = Math.ceil(frequencies.length / ITEMS_PER_PAGE) || 1;
        let page = 0;

        const generateEmbed = (pageNum) => {
          const start = pageNum * ITEMS_PER_PAGE;
          const pageItems = frequencies.slice(start, start + ITEMS_PER_PAGE);
          const embed = new EmbedBuilder()
            .setTitle(LANGUAGES.fr.list_freq)
            .setDescription(pageItems.length ? pageItems.map(item => `**${item.frequency}** - ${item.serverName}\n└── 🔗 (**${item.serverCount}** serveurs liés)`).join('\n\n') : LANGUAGES.fr.no_freq)
            .setColor('#00AAFF')
            .setTimestamp();
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
                .setLabel(`${pageNum + 1}/${totalPages}`)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
              new ButtonBuilder()
                .setCustomId('next_page')
                .setLabel('Suivant ►')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(pageNum === totalPages - 1)
            );
        };

        // Rendre les boutons visibles
        const message = await interaction.editReply({
          embeds: [generateEmbed(page)],
          components: totalPages > 1 ? [generateButtons(page)] : []
        });

        const collector = message.createMessageComponentCollector({ time: 120000 });

        collector.on('collect', async i => {
          if (i.user.id !== interaction.user.id) {
            return i.reply({ content: LANGUAGES.fr.not_owner, ephemeral: true });
          }
          if (i.customId === 'prev_page' && page > 0) page--;
          if (i.customId === 'next_page' && page < totalPages - 1) page++;
          
          await i.update({
            embeds: [generateEmbed(page)],
            components: totalPages > 1 ? [generateButtons(page)] : []
          });
        });

        collector.on('end', () => {
          interaction.editReply({ components: [] }).catch(() => {});
        });
      }
    } catch (err) {
      console.error('❌ Erreur interaction:', err.message);
      await interaction.editReply({ content: '❌ Une erreur est survenue.' }).catch(() => {});
    }
  } else if (interaction.isButton()) {
    try {
      const frequencies = [...connectedChannels.entries()]
        .map(([guildId, { frequencies }]) => {
          return [...frequencies.entries()].map(([freq, { linkedGuilds }]) => ({
            frequency: freq,
            serverName: client.guilds.cache.get(guildId)?.name || 'Inconnu',
            serverCount: linkedGuilds.size
          }));
        })
        .flat()
        .sort((a, b) => b.serverCount - a.serverCount);

      const totalPages = Math.ceil(frequencies.length / ITEMS_PER_PAGE) || 1;
      let page = parseInt(interaction.message.components[0].components[1].label.split('/')[0]) - 1;
      if (interaction.customId === 'prev_page') page = Math.max(0, page - 1);
      if (interaction.customId === 'next_page') page = Math.min(totalPages - 1, page + 1);

      const generateEmbed = (pageNum) => {
        const start = pageNum * ITEMS_PER_PAGE;
        const pageItems = frequencies.slice(start, start + ITEMS_PER_PAGE);
        const embed = new EmbedBuilder()
          .setTitle(LANGUAGES.fr.list_freq)
          .setDescription(pageItems.length ? pageItems.map(item => `**${item.frequency}** \n- ${item.serverName} \n- (${item.serverCount} serveurs liés)`).join('\n') : LANGUAGES.fr.no_freq)
          .setColor('#00AAFF')
          .setTimestamp();
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
              .setLabel(`${pageNum + 1}/${totalPages}`)
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true),
            new ButtonBuilder()
              .setCustomId('next_page')
              .setLabel('Suivant ►')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(pageNum === totalPages - 1)
          );
      };

      await interaction.update({
        embeds: [generateEmbed(page)],
        components: totalPages > 1 ? [generateButtons(page)] : []
      });
    } catch (err) {
      console.error('❌ Erreur bouton:', err.message);
      await interaction.update({ content: '❌ Une erreur est survenue.', components: [] }).catch(() => {});
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot || message.stickers.size > 0) {
    if (message.stickers.size > 0) await message.delete().catch(err => console.error('⚠️ Erreur suppression sticker:', err.message));
    return;
  }
  const guildId = message.guildId;
  const guildData = connectedChannels.get(guildId);
  if (!guildData || message.channelId !== guildData.channelId) return;

  const content = encodeMentions(message.content || '');
  const files = Array.from(message.attachments.values()).filter(att => att.size <= MAX_FILE_SIZE).map(att => att.url);
  const embeds = message.embeds.filter(e => e.image?.url).map(e => ({ url: e.image.url }));
  const guildName = message.guild?.name || 'Serveur Inconnu';

  const targetChannels = new Set();

  // Owned frequencies
  for (const [freq, data] of guildData.frequencies) {
    for (const linkedGuildId of data.linkedGuilds) {
      const linkedData = connectedChannels.get(linkedGuildId);
      if (linkedData?.channelId) targetChannels.add(linkedData.channelId);
    }
  }

  // Linked frequencies
  const linkedFreqs = db.prepare('SELECT freq FROM links WHERE linked_guild_id = ?').all(guildId);
  for (const { freq } of linkedFreqs) {
    const owner = db.prepare('SELECT owner_guild_id FROM frequencies WHERE freq = ?').get(freq);
    if (owner) {
      const ownerData = connectedChannels.get(owner.owner_guild_id);
      if (ownerData?.channelId) targetChannels.add(ownerData.channelId);
      const freqData = ownerData?.frequencies.get(freq);
      if (freqData) {
        for (const linkedGuildId of freqData.linkedGuilds) {
          if (linkedGuildId !== guildId) {
            const linkedData = connectedChannels.get(linkedGuildId);
            if (linkedData?.channelId) targetChannels.add(linkedData.channelId);
          }
        }
      }
    }
  }

  if (message.reference?.messageId) {
    const relayed = relayMap.get(message.reference.messageId);
    if (relayed) {
      const originalChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
      if (!originalChannel?.isTextBased() || !originalChannel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) return;
      const originalMessage = await originalChannel.messages.fetch(relayed.originalId).catch(() => null);
      if (!originalMessage) return;
      const replyContent = `> <@${originalMessage.author.id}> : ${encodeMentions(originalMessage.content || 'Message sans texte')}\n${content}`;
      const webhook = await getWebhook(originalChannel);
      if (!webhook) return;
      const sent = await webhook.send({ 
        content: replyContent, 
        username: `${message.author.username} (${guildName})`, 
        avatarURL: message.author.displayAvatarURL(), 
        files 
      }).catch(err => {
        console.error(`❌ Erreur envoi réponse webhook canal ${originalChannel.id} (serveur ${originalChannel.guild?.name || 'Inconnu'}):`, err.message);
        return null;
      });
      if (sent) {
        relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
        for (const { url } of embeds) {
          await webhook.send({ 
            username: `${message.author.username} (${guildName})`, 
            avatarURL: message.author.displayAvatarURL(), 
            files: [url] 
          }).catch(err => console.error(`❌ Erreur envoi embed réponse webhook canal ${originalChannel.id} (serveur ${originalChannel.guild?.name || 'Inconnu'}):`, err.message));
        }
      }
      return;
    }
  }
  
  await Promise.allSettled([...targetChannels].map(async channelId => {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.permissionsFor(client.user).has(['SendMessages', 'EmbedLinks'])) {
      console.warn(LANGUAGES.fr.missing_access.replace('{channelId}', channelId).replace('{guildName}', channel?.guild?.name || 'Inconnu'));
      return;
    }
    const webhook = await getWebhook(channel);
    if (!webhook) return;
    const sent = await webhook.send({
      content: message.channel.isThread() ? `[Thread: ${message.channel.name}] ${content}` : content,
      username: `${message.author.username} (${guildName})`,
      avatarURL: message.author.displayAvatarURL(),
      files
    }).catch(err => {
      console.error(`❌ Erreur envoi webhook canal ${channelId} (serveur ${channel.guild?.name || 'Inconnu'}):`, err.message);
      return null;
    });
    if (sent) {
      relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
      for (const { url } of embeds) {
        await webhook.send({ 
          username: `${message.author.username} (${guildName})`, 
          avatarURL: message.author.displayAvatarURL(), 
          files: [url] 
        }).catch(err => console.error(`❌ Erreur envoi embed webhook canal ${channelId} (serveur ${channel.guild?.name || 'Inconnu'}):`, err.message));
      }
    }
  }));
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  const { message } = reaction;
  const guildData = connectedChannels.get(message.guildId);
  if (!guildData || message.channelId !== guildData.channelId) return;
  const relayed = relayMap.get(message.id);
  if (relayed) {
    const targetChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
    if (!targetChannel?.isTextBased() || !targetChannel.permissionsFor(client.user).has(['SendMessages', 'ManageMessages'])) return;
    const targetMessage = await targetChannel.messages.fetch(relayed.originalId).catch(() => null);
    if (targetMessage) await targetMessage.react(reaction.emoji.id || reaction.emoji.name).catch(err => console.error(`❌ Erreur réaction canal ${targetChannel.id}:`, err.message));
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  const { message } = reaction;
  const guildData = connectedChannels.get(message.guildId);
  if (!guildData || message.channelId !== guildData.channelId) return;
  const relayed = relayMap.get(message.id);
  if (relayed) {
    const targetChannel = await client.channels.fetch(relayed.originalChannelId).catch(() => null);
    if (!targetChannel?.isTextBased() || !targetChannel.permissionsFor(client.user).has(['SendMessages', 'ManageMessages'])) return;
    const targetMessage = await targetChannel.messages.fetch(relayed.originalId).catch(() => null);
    if (targetMessage) {
      const targetReaction = targetMessage.reactions.cache.get(reaction.emoji.id || reaction.emoji.name);
      if (targetReaction) await targetReaction.users.remove(user.id).catch(err => console.error(`❌ Erreur suppression réaction canal ${targetChannel.id}:`, err.message));
    }
  }
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
