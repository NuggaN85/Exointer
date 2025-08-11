'use strict';

import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, WebhookClient } from 'discord.js';
import fs from 'fs/promises';
import fsSync from 'fs';
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

const connectedChannels = new Map();
const relayMap = new Map();
const bannedUsers = new Set();
const DATA_FILE = './data.json';
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 Mo
const RELAY_MAP_TTL = 24 * 60 * 60 * 1000; // 24h
const LANGUAGES = {
  fr: {
    connected: '🔗 Salon connecté à **{frequency}** : {guild} ({channel})',
    disconnected: '🔌 Salon déconnecté de **{frequency}** : {guild} ({channel})',
    banned: '🚫 Utilisateur banni de **{frequency}**',
    no_frequency: '⚠️ Ce salon n\'est lié à aucune fréquence.',
    invalid_frequency: '❌ Fréquence invalide.'
  }
};

function encodeMentions(content) {
  if (!content) return content;
  
  return content
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@&?(\d{17,20})>/g, '<@\u200b$1>');
}

const webhookCache = new Map();

async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    if (!data.trim()) {
      await saveData();
      return;
    }
    const parsed = JSON.parse(data);
    connectedChannels.clear();
    for (const [freq, { channels }] of Object.entries(parsed.channels || {})) {
      connectedChannels.set(freq, new Set(channels));
    }
    console.log('📂 Données chargées depuis data.json');
  } catch (error) {
    if (error.code === 'ENOENT' || error.message.includes('Unexpected end of JSON input')) {
      await saveData();
    } else {
      console.error('❌ Erreur chargement data.json:', error.message);
    }
  }
}

async function saveData() {
  try {
    const data = {
      channels: Object.fromEntries(
        [...connectedChannels].map(([freq, channels]) => [freq, { channels: Array.from(channels), isPrivate: false }])
      ),
      logs: (await fs.readFile(DATA_FILE, 'utf8').then(d => JSON.parse(d).logs || []).catch(() => []))
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('💾 Données sauvegardées dans data.json');
  } catch (error) {
    console.error('❌ Erreur sauvegarde data.json:', error);
  }
}

async function logAction(action, details) {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8').then(d => JSON.parse(d)).catch(() => ({ logs: [] }));
    data.logs.push({ timestamp: new Date().toISOString(), action, details });
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Erreur sauvegarde log:', error);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, { timestamp }] of relayMap) {
    if (now - timestamp > RELAY_MAP_TTL) relayMap.delete(id);
  }
}, 60 * 60 * 1000);

setInterval(saveData, 5 * 60 * 1000); // Sauvegarde toutes les 5 minutes

async function getWebhook(channel) {
  if (webhookCache.has(channel.id)) return webhookCache.get(channel.id);
  if (!channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageWebhooks)) {
    console.warn(`⚠️ Permissions insuffisantes pour webhooks dans ${channel.id}`);
    return null;
  }
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find(w => w.owner.id === client.user.id);
  if (!webhook) webhook = await channel.createWebhook({ name: 'Interserveur Relay' });
  const webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
  webhookCache.set(channel.id, webhookClient);
  return webhookClient;
}

function updateActivity() {
  client.user.setActivity(`Je suis sur ${client.guilds.cache.size} serveurs`, { type: ActivityType.Custom });
}

const commands = [
  new SlashCommandBuilder()
    .setName('interserveur')
    .setDescription('Gérer les connexions inter-serveurs')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addSubcommand(subcommand =>
      subcommand
        .setName('generer')
        .setDescription('Générer une fréquence sécurisée')
        .addBooleanOption(option => option.setName('privee').setDescription('Fréquence privée ?').setRequired(false))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('lier')
        .setDescription('Lier ce salon à une fréquence')
        .addStringOption(option => option.setName('frequence').setDescription('La fréquence à lier').setRequired(true))
        .addStringOption(option => option.setName('cle').setDescription('Clé pour fréquences privées').setRequired(false))
    )
    .addSubcommand(subcommand => subcommand.setName('gerer').setDescription('Voir la fréquence du salon'))
    .addSubcommand(subcommand => subcommand.setName('liste').setDescription('Liste des serveurs avec fréquences'))
    .addSubcommand(subcommand => subcommand.setName('delier').setDescription('Délier ce salon'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('ban')
        .setDescription('Bannir un utilisateur d\'une fréquence')
        .addUserOption(option => option.setName('utilisateur').setDescription('Utilisateur à bannir').setRequired(true))
        .addStringOption(option => option.setName('frequence').setDescription('Fréquence cible').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('info')
        .setDescription('Infos sur la fréquence')
        .addStringOption(option => option.setName('frequence').setDescription('Fréquence à inspecter').setRequired(true))
    )
].map(cmd => cmd.toJSON());

client.on('guildCreate', () => updateActivity());
client.on('guildDelete', async guild => {
  updateActivity();
  for (const [frequency, channels] of connectedChannels) {
    channels.delete(guild.id);
    if (channels.size === 0) connectedChannels.delete(frequency);
  }
  await saveData();
  await logAction('guildDelete', { guildId: guild.id });
});

client.on('ready', async () => {
  console.log(`✅ Bot connecté en tant que ${client.user.tag}!`);
  await loadData();
  updateActivity();

  for (const [frequency, channels] of connectedChannels) {
    if (channels.size === 0) continue;
    const channelId = channels.values().next().value;
    const channel = await client.channels.fetch(channelId).catch(() => null);
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
        .setFooter({ text: `Fréquence: ${frequency}` });
      await channel.send({ embeds: [embed] });
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

client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;
  if (interaction.replied || interaction.deferred) return;

  if (interaction.commandName === 'interserveur') {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: '❌ Vous devez avoir la permission "Gérer les salons" pour utiliser cette commande.', ephemeral: true });
    }
  }

  if (interaction.commandName === 'interserveur') {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'generer') {
      const isPrivate = interaction.options.getBoolean('privee') || false;
      const frequency = uuidv4().slice(0, 8);
      const key = isPrivate ? uuidv4().slice(0, 12) : null;
      connectedChannels.set(frequency, new Set([interaction.channelId]));
      await saveData();
      await interaction.reply({
        content: `📡 Fréquence générée : **${frequency}**${isPrivate ? `\nClé : **${key}**` : ''}`,
        ephemeral: true
      });
      await logAction('generate', { frequency, channel: interaction.channelId, isPrivate });
    }

    if (subcommand === 'lier') {
      const frequency = interaction.options.getString('frequence');
      const key = interaction.options.getString('cle');
      const channelSet = connectedChannels.get(frequency);

      if (!channelSet) {
        await interaction.reply({ content: LANGUAGES.fr.invalid_frequency, ephemeral: true });
        return;
      }

      if (channelSet.has(interaction.channelId)) {
        await interaction.reply({ content: '⚠️ Salon déjà lié.', ephemeral: true });
        return;
      }

      channelSet.add(interaction.channelId);
      await saveData();
      await interaction.reply({ content: `🔗 Salon lié à **${frequency}**.`, ephemeral: true });

      const content = LANGUAGES.fr.connected
        .replace('{frequency}', frequency)
        .replace('{guild}', interaction.guild.name)
        .replace('{channel}', interaction.channel.name);

      await Promise.all([...channelSet].map(async channelId => {
        if (channelId !== interaction.channelId) {
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (channel?.isTextBased()) await channel.send({ content });
        }
      }));

      await logAction('link', { frequency, channel: interaction.channelId });
    }

    if (subcommand === 'gerer') {
      const frequency = [...connectedChannels.entries()].find(([_, v]) => v.has(interaction.channelId))?.[0];
      await interaction.reply({
        content: frequency ? `📡 Fréquence : **${frequency}**` : LANGUAGES.fr.no_frequency,
        ephemeral: true
      });
    }

    if (subcommand === 'delier') {
      let found = false;
      for (const [frequency, channels] of connectedChannels) {
        if (channels.has(interaction.channelId)) {
          found = true;
          channels.delete(interaction.channelId);
          await interaction.reply({ content: `🔌 Délié de **${frequency}**`, ephemeral: true });

          const content = LANGUAGES.fr.disconnected
            .replace('{frequency}', frequency)
            .replace('{guild}', interaction.guild.name)
            .replace('{channel}', interaction.channel.name);

          await Promise.all([...channels].map(async channelId => {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (channel?.isTextBased()) await channel.send({ content });
          }));

          if (channels.size === 0) connectedChannels.delete(frequency);
          await saveData();
          await logAction('unlink', { frequency, channel: interaction.channelId });
          break;
        }
      }
      if (!found) await interaction.reply({ content: LANGUAGES.fr.no_frequency, ephemeral: true });
    }

    if (subcommand === 'liste') {
      const serverMap = new Map();
      for (const [frequency, channels] of connectedChannels) {
        const channelId = channels.values().next().value;
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;
        const guildIds = new Set([...channels].map(id => client.channels.cache.get(id)?.guildId).filter(Boolean));
        serverMap.set(frequency, {
          name: channel.guild.name,
          frequency,
          liaisonCount: guildIds.size,
          isPrivate: false
        });
      }

      const servers = Array.from(serverMap.values());
      if (!servers.length) {
        await interaction.reply({ content: '⚠️ Aucune fréquence active.', ephemeral: true });
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
          .setTitle('🌐 Fréquences inter-serveur actives')
          .setDescription('📋 Liste des fréquences.')
          .setColor('#FFD700')
          .setTimestamp();
        pageServers.forEach(s => {
          embed.addFields({
            name: `🏠 ${s.name}`,
            value: `🔗 Liaisons: ${s.liaisonCount} serveur${s.liaisonCount > 1 ? 's' : ''}\n${s.isPrivate ? '🔒 Privée' : '🌍 Publique'}\n📡 Fréquence: \`\`\`${s.frequency}\`\`\``,
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

        return { embeds: [embed], components: [row] };
      };

      await interaction.reply({ ...getPageContent(page), ephemeral: true });
      const message = await interaction.fetchReply();
      const filter = i => i.user.id === interaction.user.id && ['prev_page', 'next_page'].includes(i.customId);
      const collector = message.createMessageComponentCollector({ filter, time: 60000 });

      collector.on('collect', async i => {
        page += i.customId === 'next_page' ? 1 : -1;
        await i.update({ ...getPageContent(page), ephemeral: true });
      });

      collector.on('end', async () => {
        try {
          await message.edit({ ...getPageContent(page), components: [] });
        } catch (e) {}
      });
    }

    if (subcommand === 'ban') {
      const user = interaction.options.getUser('utilisateur');
      const frequency = interaction.options.getString('frequence');
      if (!connectedChannels.has(frequency)) {
        await interaction.reply({ content: LANGUAGES.fr.invalid_frequency, ephemeral: true });
        return;
      }
      bannedUsers.add(`${frequency}:${user.id}`);
      await interaction.reply({ content: LANGUAGES.fr.banned.replace('{frequency}', frequency), ephemeral: true });
      await logAction('ban', { frequency, user: user.id });
    }

    if (subcommand === 'info') {
      const frequency = interaction.options.getString('frequence');
      const channels = connectedChannels.get(frequency);
      if (!channels) {
        await interaction.reply({ content: LANGUAGES.fr.invalid_frequency, ephemeral: true });
        return;
      }

      const guilds = new Set();
      let memberCount = 0;
      await Promise.all([...channels].map(async channelId => {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          guilds.add(channel.guild.name);
          memberCount += channel.guild.memberCount;
        }
      }));

      const embed = new EmbedBuilder()
        .setTitle(`📡 Infos Fréquence ${frequency}`)
        .setDescription(`Type: 🌍 Publique`)
        .addFields(
          { name: '🏠 Serveurs', value: `${guilds.size} (${[...guilds].join(', ')})`, inline: true },
          { name: '👥 Membres', value: `${memberCount}`, inline: true },
          { name: '📚 Salons', value: `${channels.size}`, inline: true }
        )
        .setColor('#FFD700')
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const frequency = [...connectedChannels.entries()].find(([_, v]) => v.has(message.channelId))?.[0];
  if (!frequency) return;
  if (bannedUsers.has(`${frequency}:${message.author.id}`)) return;

  if (message.stickers.size > 0) {
    await message.delete().catch(err => console.error('⚠️ Erreur suppression sticker:', err.message));
    return;
  }

  const channels = connectedChannels.get(frequency);
  const content = encodeMentions(message.content || '');
  const files = Array.from(message.attachments.values())
    .filter(att => att.size <= MAX_FILE_SIZE)
    .map(att => att.url);
  const embeds = message.embeds.filter(e => e.image?.url).map(e => ({ url: e.image.url }));

  if (message.reference?.messageId) {
    const relayInfo = relayMap.get(message.reference.messageId);
    if (relayInfo) {
      const originalChannel = await client.channels.fetch(relayInfo.originalChannelId).catch(() => null);
      const originalMessage = await originalChannel?.messages.fetch(relayInfo.originalId).catch(() => null);
      if (originalMessage) {
        const replyContent = `> <@${originalMessage.author.id}> a dit : ${encodeMentions(originalMessage.content || 'Message sans texte')}\n${content}`;
        const webhook = await getWebhook(originalChannel);
        if (webhook) {
          const sent = await webhook.send({ content: replyContent, username: message.author.username, avatarURL: message.author.displayAvatarURL(), files });
          relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
          for (const { url } of embeds) {
            await webhook.send({ username: message.author.username, avatarURL: message.author.displayAvatarURL(), files: [url] });
          }
        }
      }
      return;
    }
  }

  await Promise.all([...channels].map(async channelId => {
    if (channelId !== message.channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased()) return;

      const webhook = await getWebhook(channel);
      if (!webhook) return;

      const sent = await webhook.send({
        content: message.channel.isThread() ? `[Thread: ${message.channel.name}]\n${content}` : content,
        username: message.author.username,
        avatarURL: message.author.displayAvatarURL(),
        files
      });

      for (const { url } of embeds) {
        await webhook.send({ username: message.author.username, avatarURL: message.author.displayAvatarURL(), files: [url] });
      }

      relayMap.set(sent.id, { originalId: message.id, originalChannelId: message.channelId, timestamp: Date.now() });
    }
  }));
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  const message = reaction.message;
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
          await targetMessage.react(reaction.emoji.id || reaction.emoji.name).catch(() => {});
        }
      }
    }
  }));
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  const message = reaction.message;
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
          if (targetReaction) {
            await targetReaction.users.remove(user.id).catch(() => {});
          }
        }
      }
    }
  }));
});

process.on('SIGINT', () => {
  try {
    const data = {
      channels: Object.fromEntries(
        [...connectedChannels].map(([freq, channels]) => [freq, { channels: Array.from(channels), isPrivate: false }])
      ),
      logs: fsSync.readFileSync(DATA_FILE, 'utf8').length ? JSON.parse(fsSync.readFileSync(DATA_FILE, 'utf8')).logs || [] : []
    };
    fsSync.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('💾 Données sauvegardées (SIGINT)');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur sauvegarde SIGINT:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', () => {
  try {
    const data = {
      channels: Object.fromEntries(
        [...connectedChannels].map(([freq, channels]) => [freq, { channels: Array.from(channels), isPrivate: false }])
      ),
      logs: fsSync.readFileSync(DATA_FILE, 'utf8').length ? JSON.parse(fsSync.readFileSync(DATA_FILE, 'utf8')).logs || [] : []
    };
    fsSync.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log('💾 Données sauvegardées (SIGTERM)');
    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur sauvegarde SIGTERM:', error);
    process.exit(1);
  }
});

process.on('uncaughtException', err => {
  console.error('❌ Erreur fatale:', err);
  try {
    const data = {
      channels: Object.fromEntries(
        [...connectedChannels].map(([freq, channels]) => [freq, { channels: Array.from(channels), isPrivate: false }])
      ),
      logs: fsSync.readFileSync(DATA_FILE, 'utf8').length ? JSON.parse(fsSync.readFileSync(DATA_FILE, 'utf8')).logs || [] : []
    };
    fsSync.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('❌ Erreur sauvegarde fatale:', e);
  }
  client.destroy();
  process.exit(1);
});

process.on('unhandledRejection', err => {
  console.error('❌ Erreur non gérée:', err);
  try {
    const data = {
      channels: Object.fromEntries(
        [...connectedChannels].map(([freq, channels]) => [freq, { channels: Array.from(channels), isPrivate: false }])
      ),
      logs: fsSync.readFileSync(DATA_FILE, 'utf8').length ? JSON.parse(fsSync.readFileSync(DATA_FILE, 'utf8')).logs || [] : []
    };
    fsSync.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('❌ Erreur sauvegarde rejection:', e);
  }
  client.destroy();
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error('❌ Erreur connexion système:', error);
  process.exit(1);
});
