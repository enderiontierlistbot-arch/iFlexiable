require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  ChannelType, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  PermissionFlagsBits,
  AuditLogEvent
} = require('discord.js');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

// --- KORUMA VE YÖNETİM AYARLARI ---
// 1. Muaf ve Log Alıcı Rolü (Bu role sahip olanlar sınırsız yetkilidir ve tüm önemli loglar bu role DM atılır)
const EXEMPT_ROLE_ID = '1547952912485974146';

// 2. Korumalı Sınır Rol ID (Bu rol DAHİL VE ÜSTÜNDEKİ roller izinsiz verilemez, anında geri alınır!)
const THRESHOLD_ROLE_ID = '1534574522836058230';

// 3. Zaman Aşımı (Timeout) Muafiyet Eşik Rolü:
// Bu rol ve üzerindeki yetkililer istediği kadar zaman aşımı atabilir.
// Bu rolün altındakiler ise 1 saat içinde en fazla 3 kişiye zaman aşımı atabilir.
const TIMEOUT_EXEMPT_ROLE_ID = '1548422146852782230';
const TIMEOUT_LIMIT = 3;
const TIMEOUT_WINDOW_MS = 60 * 60 * 1000; // 1 saat (60 dakika)

// 4. Rol alma sınırı (Muaf olmayan yetkili 6 kişiden rol alırsa yetkileri çekilir)
const MAX_REMOVE_TARGETS = 6;

// İşlem takip hafızaları
const roleRemoveTracker = new Map(); // executorId -> Set<targetMemberId>
const timeoutTracker = new Map();    // executorId -> Array<timestamp>

// Token kontrolü
if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'BURAYA_BOT_TOKENINIZI_YAZIN') {
  console.error('\n❌ HATA: .env dosyasında geçerli bir BOT_TOKEN bulunamadı!');
  process.exit(1);
}

// Bot istemcisi
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages
  ]
});

// --- YÖNETİCİLERE DM LOG GÖNDERME FONKSİYONU ---
async function sendLogToManagers(guild, logMessage) {
  try {
    await guild.members.fetch().catch(() => {});
    
    // EXEMPT_ROLE_ID rolüne sahip bot olmayan yetkilileri bul
    const managers = guild.members.cache.filter(
      member => member.roles.cache.has(EXEMPT_ROLE_ID) && !member.user.bot
    );

    const fullMessage = `🛡️ **[SUNUCU GÜVENLİK LOGU]**\n📍 **Sunucu:** ${guild.name}\n${logMessage}\n⏰ **Zaman:** <t:${Math.floor(Date.now() / 1000)}:R>`;

    for (const [id, manager] of managers) {
      await manager.send(fullMessage).catch(() => {});
    }
  } catch (err) {
    console.error('[LOG GÖNDERME HATASI]:', err.message);
  }
}

// Bot hazır olduğunda çalışacak kodlar
client.once('ready', async () => {
  console.log(`\n==================================================`);
  console.log(`🤖 Bot başarıyla giriş yaptı: ${client.user.tag}`);
  console.log(`==================================================\n`);

  // Slash Komutlarının Tanımlanması
  const commands = [
    // 1. /ses-gir komutu
    new SlashCommandBuilder()
      .setName('ses-gir')
      .setDescription('Botu belirttiğiniz ses kanalına sokar.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption(option =>
        option
          .setName('kanal')
          .setDescription('Botun girmesini istediğiniz ses kanalı')
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(true)
      ),

    // 2. /dm-all komutu
    new SlashCommandBuilder()
      .setName('dm-all')
      .setDescription('Belirtilen role sahip tüm üyelere özel mesaj (DM) gönderir.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addRoleOption(option =>
        option
          .setName('rol')
          .setDescription('Mesaj gönderilecek rol')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('mesaj')
          .setDescription('Gönderilecek mesaj metni')
          .setRequired(true)
      )
  ].map(command => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

  try {
    console.log('🔄 Slash komutları Discord API\'ye kaydediliyor...');
    const clientId = process.env.CLIENT_ID && process.env.CLIENT_ID !== 'BURAYA_CLIENT_ID_YAZIN' 
      ? process.env.CLIENT_ID 
      : client.user.id;

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );
    console.log('✅ Slash komutları ( /ses-gir ve /dm-all ) kaydedildi!');
    console.log(`🛡️ Hassas Koruma & DM Log Sistemi Aktif!`);
    console.log(`📌 Muaf ve Log Alıcı Rol ID: ${EXEMPT_ROLE_ID}`);
    console.log(`⛔ Korunan Sınır Rol ID: ${THRESHOLD_ROLE_ID} (Bu rol dahil ve üstü anında geri alınır!)`);
    console.log(`⏳ Zaman Aşımı Eşik Rol ID: ${TIMEOUT_EXEMPT_ROLE_ID} (Altındakilere 1 saatte 3 limit)\n`);
  } catch (error) {
    console.error('❌ Slash komutları kaydedilirken hata oluştu:', error);
  }
});

// --- ROL VE ZAMAN AŞIMI KORUMASI (GUILD MEMBER UPDATE) ---
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const guild = newMember.guild;

  // 1. ZAMAN AŞIMI (TIMEOUT) KONTROLÜ
  const oldTimeout = oldMember.communicationDisabledUntilTimestamp || 0;
  const newTimeout = newMember.communicationDisabledUntilTimestamp || 0;
  const isTimedOut = newTimeout > Date.now() && newTimeout > oldTimeout;

  if (isTimedOut) {
    try {
      const fetchedLogs = await guild.fetchAuditLogs({
        limit: 1,
        type: AuditLogEvent.MemberUpdate,
      }).catch(() => null);

      const logEntry = fetchedLogs?.entries.first();
      if (logEntry && logEntry.target?.id === newMember.id && (Date.now() - logEntry.createdAt.getTime() <= 7000)) {
        const executor = logEntry.executor;

        // BOTLARIN İŞLEMLERİNİ TAMAMEN YOKSAY (Ticket King vb.)
        if (executor && !executor.bot && executor.id !== client.user.id) {
          const executorMember = await guild.members.fetch(executor.id).catch(() => null);

          if (executorMember) {
            const thresholdTimeoutRole = guild.roles.cache.get(TIMEOUT_EXEMPT_ROLE_ID);
            const isTimeoutExempt = executorMember.roles.cache.has(EXEMPT_ROLE_ID) || 
              (thresholdTimeoutRole && executorMember.roles.highest.position >= thresholdTimeoutRole.position) ||
              executorMember.roles.cache.has(TIMEOUT_EXEMPT_ROLE_ID);

            if (!isTimeoutExempt) {
              const now = Date.now();
              let timestamps = timeoutTracker.get(executor.id) || [];
              timestamps = timestamps.filter(t => now - t < TIMEOUT_WINDOW_MS);
              timestamps.push(now);
              timeoutTracker.set(executor.id, timestamps);

              console.log(`[ZAMAN AŞIMI TAKİP] ⏳ ${executor.tag}, ${newMember.user.tag} kullanıcısına zaman aşımı attı. (Son 1 saatteki sayı: ${timestamps.length}/${TIMEOUT_LIMIT})`);

              // Eğer 1 saat içinde limiti aşarsa (3'ten fazla atarsa)
              if (timestamps.length > TIMEOUT_LIMIT) {
                console.log(`[ZAMAN AŞIMI LİMİTİ AŞILDI] 🚨 Yetkili ${executor.tag} 1 saatte ${timestamps.length} zaman aşımı attı! TÜM ROLLERİ ÇEKİLİYOR!`);

                const executorRoles = executorMember.roles.cache.filter(r => r.id !== guild.id);
                await executorMember.roles.set([]).catch(async () => {
                  for (const [rId, r] of executorRoles) {
                    await executorMember.roles.remove(r).catch(() => {});
                  }
                });

                // Yetkiliye ceza DM uyarısı
                await executorMember.send(
                  `🚨 **${guild.name}** sunucusunda 1 saat içinde izin verilen zaman aşımı limitini (${TIMEOUT_LIMIT}) aştığınız için tüm rolleriniz ve yetkileriniz çekilmiştir!`
                ).catch(() => {});

                // Yöneticilere DM Log
                await sendLogToManagers(guild, 
                  `🚨 **ZAMAN AŞIMI LİMİTİ AŞILDI & YETKİLER ÇEKİLDİ!**\n👤 **İşlemi Yapan:** ${executor.tag} (\`${executor.id}\`)\n🎯 **Hedef Üye:** ${newMember.user.tag} (\`${newMember.id}\`)\n⚠️ **Neden:** 1 saat içinde ${timestamps.length} kişiye zaman aşımı uyguladı.\n🔨 **İşlem:** Yetkilinin tüm rolleri çekildi.`
                );

                timeoutTracker.delete(executor.id);
                return;
              } else {
                // Limit içinde atılan her zaman aşımında ATAN KİŞİYE DM UYARISI
                const kalanHak = TIMEOUT_LIMIT - timestamps.length;
                await executorMember.send(
                  `⚠️ **${guild.name}** sunucusunda bir kullanıcıya zaman aşımı uyguladınız.\nLütfen gereksiz zaman aşımı atma, bir sorun varsa üst yetkililerine bildir! 1 saat içinde ${TIMEOUT_LIMIT} hakkınız bulunmaktadır (Kalan: ${kalanHak}). Sınırı aşarsanız tüm rolleriniz geri alınamaz şekilde gider!`
                ).catch(() => {});

                // Yöneticilere DM Log
                await sendLogToManagers(guild,
                  `⏳ **ZAMAN AŞIMI UYGULANDI**\n👤 **Yetkili:** ${executor.tag} (\`${executor.id}\`)\n🎯 **Hedef Üye:** ${newMember.user.tag} (\`${newMember.id}\`)\n📊 **Yetkilinin 1 Saatteki Sayısı:** ${timestamps.length}/${TIMEOUT_LIMIT}\nℹ️ **Durum:** Yetkiliye DM'den uyarı gönderildi.`
                );
              }
            } else {
              // Muaf yetkili zaman aşımı attığında log gönder
              await sendLogToManagers(guild,
                `⏳ **ZAMAN AŞIMI (Muaf Yetkili)**\n👤 **Yetkili:** ${executor.tag} (\`${executor.id}\`)\n🎯 **Hedef Üye:** ${newMember.user.tag} (\`${newMember.id}\`)`
              );
            }
          }
        }
      }
    } catch (e) {
      console.error('[ZAMAN AŞIMI KONTROL HATA]:', e.message);
    }
  }

  // 2. ROL DEĞİŞİKLİĞİ KONTROLÜ
  const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
  const removedRoles = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id));

  if (addedRoles.size === 0 && removedRoles.size === 0) return;

  try {
    const fetchedLogs = await guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.MemberRoleUpdate,
    }).catch(() => null);

    if (!fetchedLogs) return;
    const roleLog = fetchedLogs.entries.first();
    if (!roleLog) return;

    const { executor, target, createdAt } = roleLog;

    // BOTLARIN İŞLEMLERİNİ YOKSAY (Ticket King vb.)
    if (!executor || executor.bot || executor.id === client.user.id) return;
    if (target.id !== newMember.id) return;
    if (Date.now() - createdAt.getTime() > 7000) return;

    const executorMember = await guild.members.fetch(executor.id).catch(() => null);
    if (!executorMember) return;

    // Muafiyet kontrolü
    if (executorMember.roles.cache.has(EXEMPT_ROLE_ID)) {
      return;
    }

    // --- A) ROL VERME KORUMASI (Eski Kararlı Hali: 1534574522836058230 DAHİL VE ÜSTÜ ROLLERE İZİN VERİLMEZ) ---
    if (addedRoles.size > 0) {
      const thresholdRole = guild.roles.cache.get(THRESHOLD_ROLE_ID);

      // Verilen roller arasında THRESHOLD_ROLE_ID veya onun üstünde bir rol var mı kontrol et
      const protectedAddedRoles = addedRoles.filter(role => {
        if (role.id === THRESHOLD_ROLE_ID) return true;
        if (thresholdRole && role.position >= thresholdRole.position) return true;
        return false;
      });

      if (protectedAddedRoles.size > 0) {
        // 1. VERİLEN KORUMALI ROLÜ YENİ ÜYEDEN ANINDA GERİ AL
        await newMember.roles.remove(protectedAddedRoles).catch(() => {});
        console.log(`[KORUMA] 🚨 Yetkisiz yetkili (${executor.tag}), ${newMember.user.tag} üyesine korumalı bir rol verdi! Verilen rol (${protectedAddedRoles.map(r=>r.name).join(', ')}) ANINDA GERİ ALINDI.`);

        // Verilen roller arasında Yönetici (Administrator) yetkisi var mı kontrol et
        const hasAdminRole = protectedAddedRoles.some(r => r.permissions.has(PermissionFlagsBits.Administrator));

        if (hasAdminRole) {
          // YÖNETİCİ PERMİ VARSA: Yetkilinin TÜM ROLLERİNİ ÇEK + DM UYARI
          console.log(`[KORUMA TETİKLENDİ] 🚨 Yetkili ${executor.tag} YÖNETİCİ permli rol verdiği için TÜM ROLLERİ ÇEKİLİYOR!`);

          const executorRoles = executorMember.roles.cache.filter(r => r.id !== guild.id);
          await executorMember.roles.set([]).catch(async () => {
            for (const [rId, r] of executorRoles) {
              await executorMember.roles.remove(r).catch(() => {});
            }
          });

          await executorMember.send(
            `🚨 **${guild.name}** sunucusunda izinsiz **Yönetici** yetkisine sahip bir rol verdiğiniz için tüm yetkileriniz ve rolleriniz çekilmiştir!`
          ).catch(() => {});

          await sendLogToManagers(guild,
            `🚨 **YETKİSİZ YÖNETİCİ ROLÜ VERİLDİ & ROLLER ÇEKİLDİ!**\n👤 **İşlemi Yapan:** ${executor.tag} (\`${executor.id}\`)\n🎯 **Hedef Üye:** ${newMember.user.tag} (\`${newMember.id}\`)\n🛡️ **Verilmeye Çalışılan Rol:** ${protectedAddedRoles.map(r=>r.name).join(', ')}\n🔨 **İşlem:** Verilen rol iptal edildi ve yetkilinin tüm rolleri çekildi.`
          );
        } else {
          // YÖNETİCİ PERMİ YOKSA: Sadece verilen rolü geri al + DM UYARI GÖNDER
          await executorMember.send(
            `⚠️ **${guild.name}** sunucusunda **${protectedAddedRoles.map(r => r.name).join(', ')}** rolünü verme yetkiniz bulunmamaktadır.\nVerdiğiniz rol **${newMember.user.tag}** kullanıcısından anında geri alınmıştır.`
          ).catch(() => {});

          await sendLogToManagers(guild,
            `⚠️ **KORUMALI ROL ENGELİ (Geri Alındı)**\n👤 **Yetkili:** ${executor.tag} (\`${executor.id}\`)\n🎯 **Hedef Üye:** ${newMember.user.tag} (\`${newMember.id}\`)\n🛡️ **Engellenen Rol:** ${protectedAddedRoles.map(r=>r.name).join(', ')}\nℹ️ **Durum:** Rol geri alındı, yetkili uyarıldı.`
          );
        }
      }
    }

    // --- B) ROL ALMA KORUMASI ---
    if (removedRoles.size > 0) {
      let tracker = roleRemoveTracker.get(executor.id);
      if (!tracker) {
        tracker = new Set();
        roleRemoveTracker.set(executor.id, tracker);
      }
      tracker.add(newMember.id);

      await sendLogToManagers(guild,
        `🔻 **BİR ÜYEDEN ROL ALINDI**\n👤 **Yetkili:** ${executor.tag} (\`${executor.id}\`)\n🎯 **Rolü Alınan:** ${newMember.user.tag} (\`${newMember.id}\`)\n🎭 **Alınan Roller:** ${removedRoles.map(r=>r.name).join(', ')}\n📊 **Yetkilinin Sayacı:** ${tracker.size}/${MAX_REMOVE_TARGETS}`
      );

      if (tracker.size >= MAX_REMOVE_TARGETS) {
        console.log(`[KORUMA TETİKLENDİ] 🚨 Yetkili ${executor.tag} ${tracker.size} farklı kişiden rol aldığı için TÜM ROLLERİ ÇEKİLİYOR!`);

        const executorRoles = executorMember.roles.cache.filter(r => r.id !== guild.id);
        await executorMember.roles.set([]).catch(async () => {
          for (const [rId, r] of executorRoles) {
            await executorMember.roles.remove(r).catch(() => {});
          }
        });

        await executorMember.send(
          `🚨 **${guild.name}** sunucusunda izinsiz olarak birden fazla kişiden rol aldığınız için tüm yetkileriniz çekilmiştir!`
        ).catch(() => {});

        await sendLogToManagers(guild,
          `🚨 **ROL ALMA LİMİTİ AŞILDI & YETKİLER ÇEKİLDİ!**\n👤 **İşlemi Yapan:** ${executor.tag} (\`${executor.id}\`)\n⚠️ **Neden:** ${tracker.size} farklı kişiden rol aldı.\n🔨 **İşlem:** Yetkilinin tüm rolleri sıfırlandı.`
        );

        roleRemoveTracker.delete(executor.id);
      }
    }

  } catch (error) {
    console.error('[KORUMA HATA] Rol takibi hatası:', error.message);
  }
});

// --- KANAL AÇMA LOGU ---
client.on('channelCreate', async channel => {
  if (!channel.guild) return;
  try {
    const fetchedLogs = await channel.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.ChannelCreate,
    }).catch(() => null);

    const logEntry = fetchedLogs?.entries.first();
    const executor = logEntry ? logEntry.executor : null;

    // BOTLARIN KANAL AÇMA LOGUNU YOKSAY (Ticket King vb.)
    if (executor && executor.bot) return;

    const executorText = executor ? `${executor.tag} (\`${executor.id}\`)` : 'Bilinmiyor';

    await sendLogToManagers(channel.guild,
      `📁 **YENİ KANAL AÇILDI**\n🏷️ **Kanal:** #${channel.name} (\`${channel.id}\`)\n👤 **Açan Kişi:** ${executorText}`
    );
  } catch (e) {
    console.error('[KANAL AÇMA LOG HATA]:', e.message);
  }
});

// --- KANAL SİLME LOGU ---
client.on('channelDelete', async channel => {
  if (!channel.guild) return;
  try {
    const fetchedLogs = await channel.guild.fetchAuditLogs({
      limit: 1,
      type: AuditLogEvent.ChannelDelete,
    }).catch(() => null);

    const logEntry = fetchedLogs?.entries.first();
    const executor = logEntry ? logEntry.executor : null;

    // BOTLARIN KANAL SİLME LOGUNU YOKSAY (Ticket King vb.)
    if (executor && executor.bot) return;

    const executorText = executor ? `${executor.tag} (\`${executor.id}\`)` : 'Bilinmiyor';

    await sendLogToManagers(channel.guild,
      `🗑️ **BİR KANAL SİLİNDİ!**\n🏷️ **Silinen Kanal:** #${channel.name} (\`${channel.id}\`)\n👤 **Silen Kişi:** ${executorText}`
    );
  } catch (e) {
    console.error('[KANAL SİLME LOG HATA]:', e.message);
  }
});

// Slash Komut Etkileşimlerini Yakalama
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // --- /ses-gir Komutu ---
  if (commandName === 'ses-gir') {
    const channel = interaction.options.getChannel('kanal');

    if (!channel.isVoiceBased()) {
      return interaction.reply({ content: '❌ Lütfen geçerli bir ses kanalı seçin!', ephemeral: true });
    }

    try {
      const existingConnection = getVoiceConnection(interaction.guild.id);
      if (existingConnection) {
        existingConnection.destroy();
      }

      joinVoiceChannel({
        channelId: channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      return interaction.reply({ 
        content: `🔊 **${channel.name}** ses kanalına başarıyla katıldım!`, 
        ephemeral: false 
      });

    } catch (error) {
      console.error('Ses kanalına katılırken hata oluştu:', error);
      return interaction.reply({ 
        content: `❌ Ses kanalına katılırken bir hata oluştu: ${error.message}`, 
        ephemeral: true 
      });
    }
  }

  // --- /dm-all Komutu ---
  if (commandName === 'dm-all') {
    const role = interaction.options.getRole('rol');
    const messageText = interaction.options.getString('mesaj');

    await interaction.deferReply({ ephemeral: true });

    try {
      console.log(`[DM-ALL] ${role.name} rolüne sahip üyeler çekiliyor...`);

      let allMembers;
      try {
        allMembers = await interaction.guild.members.fetch({ force: true });
      } catch (e) {
        console.warn('[DM-ALL] Tüm üyeler çekilemedi, önbellekten okunuyor:', e.message);
        allMembers = interaction.guild.members.cache;
      }

      const membersWithRole = allMembers.filter(
        member => member.roles.cache.has(role.id) && !member.user.bot
      );

      const totalMembers = membersWithRole.size;

      if (totalMembers === 0) {
        return interaction.editReply({ 
          content: `⚠️ **${role.name}** rolüne sahip (bot olmayan) üye bulunamadı.\n\n*İpucu: Eğer bu rolde üyeler varsa, Discord Developer Portal'dan **SERVER MEMBERS INTENT** izninin açık olduğundan emin olun.*` 
        });
      }

      let successCount = 0;
      let failCount = 0;
      let current = 0;

      await interaction.editReply({
        content: `⏳ **${role.name}** rolündeki **${totalMembers}** üyenin tamamına DM gönderimi başlatıldı... (0/${totalMembers})`
      });

      for (const [id, member] of membersWithRole) {
        current++;
        try {
          await member.send(`📢 **${interaction.guild.name}** sunucusundan mesaj:\n\n${messageText}`);
          successCount++;
        } catch (err) {
          console.error(`[DM HATA] ${member.user.tag} kullanıcısına DM atılamadı (DM Kapalı/Engelli):`, err.message);
          failCount++;
        }

        if (current % 5 === 0 || current === totalMembers) {
          await interaction.editReply({
            content: `⏳ **${role.name}** rolündeki üyelere mesaj gönderiliyor... (${current}/${totalMembers})\n🟢 Başarılı: **${successCount}** | 🔴 Başarısız (DM Kapalı): **${failCount}**`
          }).catch(() => {});
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      return interaction.followUp({
        content: `✅ **Toplu DM Gönderimi Tamamlandı!**\n\n📌 **Hedef Rol:** <@&${role.id}>\n👥 **Tespit Edilen Üye Sayısı:** ${totalMembers}\n🟢 **Başarılı Gönderilen:** **${successCount}** üye\n🔴 **Başarısız (DM'si Kapalı/Engelli):** **${failCount}** üye`,
        ephemeral: true
      });

    } catch (error) {
      console.error('Toplu DM gönderilirken hata oluştu:', error);
      return interaction.editReply({ 
        content: `❌ Toplu DM gönderilirken bir hata oluştu: ${error.message}` 
      });
    }
  }
});

// Hata Yakalama
process.on('unhandledRejection', error => {
  if (error && error.message && error.message.includes('Used disallowed intents')) {
    console.error('\n❌ HATA: Discord Developer Portal üzerinde "SERVER MEMBERS INTENT" seçeneği kapalı!');
  } else {
    console.error('\n❌ Hata:', error);
  }
});

// Botu başlat
client.login(process.env.BOT_TOKEN);
