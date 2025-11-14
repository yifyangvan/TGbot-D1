/**
 * Telegram 双向机器人 Cloudflare Worker
 * 版本: v2.0 - 完整扩展版
 * 功能: 一人一话题 + 菜单优化 + @username 备份 + 完整管理员系统
 */

async function dbConfigGet(key, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
    return row ? row.value : null;
}

async function dbConfigPut(key, value, env) {
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
}

async function dbUserGetOrCreate(userId, env) {
    let user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    if (!user) {
        await env.TG_BOT_DB.prepare(
            "INSERT INTO users (user_id, user_state, is_blocked, block_count) VALUES (?, 'new', 0, 0)"
        ).bind(userId).run();
        user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    }
    if (user) {
        user.is_blocked = user.is_blocked === 1;
        user.user_info = user.user_info_json ? JSON.parse(user.user_info_json) : null;
    }
    return user;
}

async function dbUserUpdate(userId, data, env) {
    if (data.user_info) {
        data.user_info_json = JSON.stringify(data.user_info);
        delete data.user_info;
    }
    const fields = Object.keys(data).map(key => {
        if (key === 'is_blocked' && typeof data[key] === 'boolean') return 'is_blocked = ?';
        return `${key} = ?`;
    }).join(', ');
    const values = Object.keys(data).map(key => {
        if (key === 'is_blocked' && typeof data[key] === 'boolean') return data[key] ? 1 : 0;
        return data[key];
    });
    await env.TG_BOT_DB.prepare(`UPDATE users SET ${fields} WHERE user_id = ?`).bind(...values, userId).run();
}

async function dbTopicUserGet(topicId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT user_id FROM users WHERE topic_id = ?").bind(topicId).first();
    return row ? row.user_id : null;
}

async function dbUserTopicExists(userId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT topic_id FROM users WHERE user_id = ? AND topic_id IS NOT NULL").bind(userId).first();
    return row ? row.topic_id : null;
}

async function dbMessageDataPut(userId, messageId, data, env) {
    await env.TG_BOT_DB.prepare(
        "INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?, ?, ?, ?)"
    ).bind(userId, messageId, data.text, data.date).run();
}

async function dbMessageDataGet(userId, messageId, env) {
    const row = await env.TG_BOT_DB.prepare(
        "SELECT text, date FROM messages WHERE user_id = ? AND message_id = ?"
    ).bind(userId, messageId).first();
    return row || null;
}

async function dbAdminStateDelete(userId, env) {
    await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${userId}`).run();
}

async function dbAdminStateGet(userId, env) {
    return await dbConfigGet(`admin_state:${userId}`, env);
}

async function dbAdminStatePut(userId, stateJson, env) {
    await dbConfigPut(`admin_state:${userId}`, stateJson, env);
}

async function dbAdminMenuMsgIdGet(userId, env) {
    return await dbConfigGet(`admin_menu_msg_id:${userId}`, env);
}

async function dbAdminMenuMsgIdPut(userId, messageId, env) {
    await dbConfigPut(`admin_menu_msg_id:${userId}`, messageId.toString(), env);
}

async function dbMigrate(env) {
    if (!env.TG_BOT_DB) throw new Error("D1 database binding 'TG_BOT_DB' is missing.");
    const configTable = `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);`;
    const usersTable = `
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY NOT NULL,
            user_state TEXT NOT NULL DEFAULT 'new',
            is_blocked INTEGER NOT NULL DEFAULT 0,
            block_count INTEGER NOT NULL DEFAULT 0,
            topic_id TEXT,
            user_info_json TEXT
        );
    `;
    const messagesTable = `
        CREATE TABLE IF NOT EXISTS messages (
            user_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            text TEXT,
            date INTEGER,
            PRIMARY KEY (user_id, message_id)
        );
    `;
    await env.TG_BOT_DB.batch([
        env.TG_BOT_DB.prepare(configTable),
        env.TG_BOT_DB.prepare(usersTable),
        env.TG_BOT_DB.prepare(messagesTable),
    ]);
}

function escapeHtml(text) {
    if (!text) return '';
    return text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function getUserInfo(user, initialTimestamp = null) {
    const userId = user.id.toString();
    const rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
    const rawUsername = user.username ? `@${user.username}` : "无";
    const safeName = escapeHtml(rawName);
    const safeUsername = escapeHtml(rawUsername);
    const safeUserId = escapeHtml(userId);
    const topicName = `${rawName.trim()} | ${userId}`.substring(0, 128);
    const timestamp = initialTimestamp ? new Date(initialTimestamp * 1000).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');
    const infoCard = `
<b>用户资料卡</b>
---
• 昵称/名称: <code>${safeName}</code>
• 用户名: <code>${safeUsername}</code>
• ID: <code>${safeUserId}</code>
• 首次连接时间: <code>${timestamp}</code>
    `.trim();
    return { userId, name: rawName, username: rawUsername, topicName, infoCard };
}

function getInfoCardButtons(userId, isBlocked) {
    const blockAction = isBlocked ? "unblock" : "block";
    const blockText = isBlocked ? "解除屏蔽 (Unblock)" : "屏蔽此人 (Block)";
    return {
        inline_keyboard: [
            [{ text: blockText, callback_data: `${blockAction}:${userId}` }],
            [{ text: "置顶此消息 (Pin Card)", callback_data: `pin_card:${userId}` }]
        ]
    };
}

async function getConfig(key, env, defaultValue) {
    const configValue = await dbConfigGet(key, env);
    if (configValue !== null) return configValue;
    const envKey = key.toUpperCase().replace('WELCOME_MSG', 'WELCOME_MESSAGE').replace('VERIF_Q', 'VERIFICATION_QUESTION').replace('VERIF_A', 'VERIFICATION_ANSWER').replace(/_FORWARDING/g, '_FORWARDING');
    const envValue = env[envKey];
    if (envValue !== undefined && envValue !== null) return envValue;
    return defaultValue;
}

function isPrimaryAdmin(userId, env) {
    if (!env.ADMIN_IDS) return false;
    const adminIds = env.ADMIN_IDS.split(',').map(id => id.trim());
    return adminIds.includes(userId.toString());
}

async function getAuthorizedAdmins(env) {
    const jsonString = await getConfig('authorized_admins', env, '[]');
    try {
        const adminList = JSON.parse(jsonString);
        return Array.isArray(adminList) ? adminList.map(id => id.toString().trim()).filter(id => id !== "") : [];
    } catch (e) {
        console.error("Failed to parse authorized_admins:", e);
        return [];
    }
}

async function isAdminUser(userId, env) {
    if (isPrimaryAdmin(userId, env)) return true;
    const authorizedAdmins = await getAuthorizedAdmins(env);
    return authorizedAdmins.includes(userId.toString());
}

async function getAutoReplyRules(env) {
    const jsonString = await getConfig('keyword_responses', env, '[]');
    try {
        const rules = JSON.parse(jsonString);
        return Array.isArray(rules) ? rules : [];
    } catch (e) {
        console.error("Failed to parse keyword_responses:", e);
        return [];
    }
}

async function getBlockKeywords(env) {
    const jsonString = await getConfig('block_keywords', env, '[]');
    try {
        const keywords = JSON.parse(jsonString);
        return Array.isArray(keywords) ? keywords : [];
    } catch (e) {
        console.error("Failed to parse block_keywords:", e);
        return [];
    }
}

async function telegramApi(token, methodName, params = {}) {
    const url = `https://api.telegram.org/bot${token}/${methodName}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
    });
    let data;
    try { data = await response.json(); } catch (e) {
        throw new Error(`Telegram API ${methodName} non-JSON`);
    }
    if (!data.ok) throw new Error(`${methodName} failed: ${data.description || JSON.stringify(data)}`);
    return data.result;
}

async function resolveChatId(identifier, env) {
    if (!identifier.startsWith('@')) return identifier;
    try {
        const chat = await telegramApi(env.BOT_TOKEN, "getChat", { chat_id: identifier });
        return chat.id.toString();
    } catch (e) {
        console.error("无法解析用户名:", identifier);
        return null;
    }
}

export default {
    async fetch(request, env, ctx) {
        try { await dbMigrate(env); } catch (e) {
            return new Response(`D1 Init Error: ${e.message}`, { status: 500 });
        }
        if (request.method === "POST") {
            try {
                const update = await request.json();
                ctx.waitUntil(handleUpdate(update, env));
            } catch (e) { console.error("处理更新出错:", e); }
        }
        return new Response("OK");
    },
};

async function handleUpdate(update, env) {
    if (update.message) {
        if (update.message.chat.type === "private") {
            await handlePrivateMessage(update.message, env);
        } else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) {
            await handleAdminReply(update.message, env);
        }
    } else if (update.edited_message) {
        if (update.edited_message.chat.type === "private") {
            await handleRelayEditedMessage(update.edited_message, env);
        }
    } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
    }
}

// --- 私聊处理 ---
async function handlePrivateMessage(message, env) {
    const chatId = message.chat.id.toString();
    const text = message.text || "";
    const userId = chatId;
    const isPrimary = isPrimaryAdmin(userId, env);
    const isAdmin = await isAdminUser(userId, env);

    if (text === "/start" || text === "/help") {
        if (isPrimary) {
            await handleAdminConfigStart(chatId, env);
        } else {
            await handleStart(chatId, env);
        }
        return;
    }

    const user = await dbUserGetOrCreate(userId, env);
    if (user.is_blocked) return;

    if (isPrimary) {
        const adminStateJson = await dbAdminStateGet(userId, env);
        if (adminStateJson) {
            await handleAdminConfigInput(userId, text, adminStateJson, env);
            return;
        }
        if (user.user_state !== "verified") {
            user.user_state = "verified";
            await dbUserUpdate(userId, { user_state: "verified" }, env);
        }
    }

    if (isAdmin && user.user_state !== "verified") {
        user.user_state = "verified";
        await dbUserUpdate(userId, { user_state: "verified" }, env);
    }

    const userState = user.user_state;
    if (userState === "pending_verification") {
        await handleVerification(chatId, text, env);
    } else if (userState === "verified") {
        const blockKeywords = await getBlockKeywords(env);
        const blockThreshold = parseInt(await getConfig('block_threshold', env, "5"), 10) || 5;
        if (blockKeywords.length > 0 && text) {
            let currentCount = user.block_count;
            for (const keyword of blockKeywords) {
                try {
                    const regex = new RegExp(keyword, 'gi');
                    if (regex.test(text)) {
                        currentCount += 1;
                        await dbUserUpdate(userId, { block_count: currentCount }, env);
                        const blockNotification = `您的消息触发了屏蔽关键词 (${currentCount}/${blockThreshold}次)，此消息已被丢弃。`;
                        if (currentCount >= blockThreshold) {
                            await dbUserUpdate(userId, { is_blocked: true }, env);
                            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "您已被自动屏蔽。" });
                            return;
                        }
                        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: blockNotification });
                        return;
                    }
                } catch (e) { console.error("Invalid regex:", keyword); }
            }
        }

        const filters = {
            media: (await getConfig('enable_image_forwarding', env, 'true')).toLowerCase() === 'true',
            link: (await getConfig('enable_link_forwarding', env, 'true')).toLowerCase() === 'true',
            text: (await getConfig('enable_text_forwarding', env, 'true')).toLowerCase() === 'true',
            channel_forward: (await getConfig('enable_channel_forwarding', env, 'true')).toLowerCase() === 'true',
            any_forward: (await getConfig('enable_forward_forwarding', env, 'true')).toLowerCase() === 'true',
            audio_voice: (await getConfig('enable_audio_forwarding', env, 'true')).toLowerCase() === 'true',
            sticker_gif: (await getConfig('enable_sticker_forwarding', env, 'true')).toLowerCase() === 'true',
        };

        let isForwardable = true;
        let filterReason = '';
        const hasLinks = (msg) => (msg.entities || msg.caption_entities || []).some(e => e.type === 'url' || e.type === 'text_link');

        if (message.forward_from || message.forward_from_chat) {
            if (!filters.any_forward) { isForwardable = false; filterReason = '转发消息'; }
            else if (message.forward_from_chat?.type === 'channel' && !filters.channel_forward) { isForwardable = false; filterReason = '频道转发'; }
        } else if (message.audio || message.voice) {
            if (!filters.audio_voice) { isForwardable = false; filterReason = '音频/语音'; }
        } else if (message.sticker || message.animation) {
            if (!filters.sticker_gif) { isForwardable = false; filterReason = '贴纸/GIF'; }
        } else if (message.photo || message.video || message.document) {
            if (!filters.media) { isForwardable = false; filterReason = '媒体内容'; }
        }

        if (isForwardable && hasLinks(message) && !filters.link) {
            isForwardable = false; filterReason = filterReason ? `${filterReason} (含链接)` : '包含链接';
        }

        const isPureText = message.text && !message.photo && !message.video && !message.document && !message.sticker && !message.audio && !message.voice && !message.forward_from_chat && !message.forward_from && !message.animation;
        if (isForwardable && isPureText && !filters.text) {
            isForwardable = false; filterReason = '纯文本';
        }

        if (!isForwardable) {
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: `此消息已被过滤：${filterReason}` });
            return;
        }

        const autoResponseRules = await getAutoReplyRules(env);
        if (autoResponseRules.length > 0 && text) {
            for (const rule of autoResponseRules) {
                try {
                    const regex = new RegExp(rule.keywords, 'gi');
                    if (regex.test(text)) {
                        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "此消息为自动回复\n\n" + rule.response });
                        return;
                    }
                } catch (e) { console.error("Invalid auto-reply regex:", rule.keywords); }
            }
        }

        await handleRelayToTopic(message, user, env);
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "请使用 /start 命令开始。" });
    }
}

async function handleStart(chatId, env) {
    const welcomeMessage = await getConfig('welcome_msg', env, "欢迎！请完成人机验证。");
    const defaultQuestion = "问题：1+1=?\n\n提示：答案在机器人简介中。";
    const verificationQuestion = await getConfig('verif_q', env, defaultQuestion);
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeMessage });
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: verificationQuestion });
    await dbUserUpdate(chatId, { user_state: "pending_verification" }, env);
}

async function handleVerification(chatId, answer, env) {
    const expected = await getConfig('verif_a', env, "3");
    if (answer.trim() === expected.trim()) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "验证通过！" });
        await dbUserUpdate(chatId, { user_state: "verified" }, env);
    } else {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "验证失败，请查看简介重新回答。" });
    }
}

// --- 一人一话题 ---
async function handleRelayToTopic(message, user, env) {
    const { from: userDetails, date } = message;
    const { userId, topicName, infoCard } = getUserInfo(userDetails, date);
    let topicId = user.topic_id;
    const isBlocked = user.is_blocked;

    const createTopicForUser = async () => {
        const existing = await dbUserTopicExists(userId, env);
        if (existing) return existing;

        await env.TG_BOT_DB.prepare("UPDATE users SET topic_id = topic_id WHERE user_id = ?").bind(userId).run();

        try {
            const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
                chat_id: env.ADMIN_GROUP_ID,
                name: topicName,
            });
            const newTopicId = newTopic.message_thread_id.toString();
            const { name, username } = getUserInfo(userDetails, date);
            const newInfo = { name, username, first_message_timestamp: date };
            await dbUserUpdate(userId, { topic_id: newTopicId, user_info: newInfo }, env);
            await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                text: infoCard,
                message_thread_id: newTopicId,
                parse_mode: "HTML",
                reply_markup: getInfoCardButtons(userId, isBlocked),
            });
            return newTopicId;
        } catch (e) {
            console.error("createTopicForUser failed:", e);
            throw e;
        }
    };

    if (!topicId) {
        const existing = await dbUserTopicExists(userId, env);
        if (existing) {
            topicId = existing;
            await dbUserUpdate(userId, { topic_id: topicId }, env);
        } else {
            topicId = await createTopicForUser();
        }
    }

    const tryCopyToTopic = async (targetTopicId) => {
        try {
            return await telegramApi(env.BOT_TOKEN, "copyMessage", {
                chat_id: env.ADMIN_GROUP_ID,
                from_chat_id: userId,
                message_id: message.message_id,
                message_thread_id: targetTopicId,
            });
        } catch (e) {
            if (e.message.includes("message thread not found") || e.message.includes("chat not found")) {
                console.warn(`话题 ${targetTopicId} 不存在。`);
            } else {
                console.error(`copyMessage failed:`, e);
            }
            throw e;
        }
    };

    try {
        await tryCopyToTopic(topicId);
    } catch (e) {
        try {
            await dbUserUpdate(userId, { topic_id: null }, env);
            const newTopicId = await createTopicForUser();
            await tryCopyToTopic(newTopicId);
        } catch (e2) {
            console.error("重建话题失败:", e2);
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "抱歉，消息转发失败。请稍后再试。" });
            return;
        }
    }

    if (message.text) {
        await dbMessageDataPut(userId, message.message_id.toString(), { text: message.text, date: message.date }, env);
    }

    // 备份群组
    const rawBackupId = await getConfig('backup_group_id', env, "");
    if (rawBackupId) {
        const backupGroupId = await resolveChatId(rawBackupId, env);
        if (!backupGroupId) return;
        const userInfo = getUserInfo(message.from, message.date);
        const fromUserHeader = `
<b>--- 备份消息 ---</b>
来自用户: <a href="tg://user?id=${userInfo.userId}">${userInfo.name || '无昵称'}</a>
• ID: <code>${userInfo.userId}</code>
• 用户名: ${userInfo.username}
------------------
`.trim() + '\n\n';
        const backupParams = { chat_id: backupGroupId, disable_notification: true, parse_mode: "HTML" };
        try {
            if (message.text) {
                await telegramApi(env.BOT_TOKEN, "sendMessage", { ...backupParams, text: fromUserHeader + message.text });
            } else if (message.photo?.length) {
                await telegramApi(env.BOT_TOKEN, "sendPhoto", { ...backupParams, photo: message.photo[message.photo.length - 1].file_id, caption: fromUserHeader + (message.caption || "") });
            } else if (message.video) {
                await telegramApi(env.BOT_TOKEN, "sendVideo", { ...backupParams, video: message.video.file_id, caption: fromUserHeader + (message.caption || "") });
            } else if (message.document) {
                await telegramApi(env.BOT_TOKEN, "sendDocument", { ...backupParams, document: message.document.file_id, caption: fromUserHeader + (message.caption || "") });
            } else if (message.audio) {
                await telegramApi(env.BOT_TOKEN, "sendAudio", { ...backupParams, audio: message.audio.file_id, caption: fromUserHeader + (message.caption || "") });
            } else if (message.voice) {
                await telegramApi(env.BOT_TOKEN, "sendVoice", { ...backupParams, voice: message.voice.file_id, caption: fromUserHeader + (message.caption || "") });
            } else if (message.animation) {
                await telegramApi(env.BOT_TOKEN, "sendAnimation", { ...backupParams, animation: message.animation.file_id, caption: fromUserHeader + (message.caption || "") });
            } else if (message.sticker || message.poll || message.forward_from_chat || message.forward_from) {
                await telegramApi(env.BOT_TOKEN, "sendMessage", { ...backupParams, text: fromUserHeader.trim() });
                await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: backupGroupId, from_chat_id: userId, message_id: message.message_id });
            }
        } catch (e) {
            console.error("备份失败:", e);
        }
    }
}

async function handleRelayEditedMessage(editedMessage, env) {
    const { from: user } = editedMessage;
    const userId = user.id.toString();
    const userData = await dbUserGetOrCreate(userId, env);
    const topicId = userData.topic_id;
    if (!topicId) return;
    const storedData = await dbMessageDataGet(userId, editedMessage.message_id.toString(), env);
    let originalText = "[原始内容无法获取]";
    let originalDate = "[发送时间无法获取]";
    if (storedData) {
        originalText = storedData.text || originalText;
        originalDate = new Date(storedData.date * 1000).toLocaleString('zh-CN');
        await dbMessageDataPut(userId, editedMessage.message_id.toString(), { text: editedMessage.text || editedMessage.caption || '', date: storedData.date }, env);
    }
    const newContent = editedMessage.text || editedMessage.caption || "[非文本内容]";
    const notificationText = `
警告: 用户消息已修改
---
<b>原始信息:</b> <code>${escapeHtml(originalText)}</code>
<b>原消息时间:</b> <code>${originalDate}</code>
<b>修改后内容:</b> ${escapeHtml(newContent)}
    `.trim();
    try {
        await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID,
            text: notificationText,
            message_thread_id: topicId,
            parse_mode: "HTML",
        });
    } catch (e) {
        console.error("编辑消息通知失败:", e);
    }
}

// --- 管理员菜单系统 ---
async function handleAdminConfigStart(chatId, env) {
    const isPrimary = isPrimaryAdmin(chatId, env);
    if (!isPrimary) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "您是协管员，此菜单仅主管理员可用。" });
        return;
    }
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const menuText = `
机器人主配置菜单
请选择类别：
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: "基础配置 (验证问答)", callback_data: "config:menu:base" }],
            [{ text: "自动回复管理", callback_data: "config:menu:autoreply" }],
            [{ text: "关键词屏蔽管理", callback_data: "config:menu:keyword" }],
            [{ text: "按类型过滤管理", callback_data: "config:menu:filter" }],
            [{ text: "协管员授权设置", callback_data: "config:menu:authorized" }],
            [{ text: "备份群组设置", callback_data: "config:menu:backup" }],
            [{ text: "刷新主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
    await dbAdminStateDelete(chatId, env);
}

// 基础配置菜单
async function handleAdminBaseConfigMenu(chatId, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const welcomeMsg = await getConfig('welcome_msg', env, "欢迎！请完成人机验证。");
    const verifQ = await getConfig('verif_q', env, "问题：1+1=?\n\n提示：答案在机器人简介中。");
    const verifA = await getConfig('verif_a', env, "3");
    const blockThreshold = await getConfig('block_threshold', env, "5");

    const menuText = `
<b>基础配置</b>
---
<b>欢迎消息:</b> <code>${escapeHtml(welcomeMsg)}</code>
<b>验证问题:</b> <code>${escapeHtml(verifQ)}</code>
<b>验证答案:</b> <code>${escapeHtml(verifA)}</code>
<b>屏蔽阈值:</b> <code>${blockThreshold}</code>
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: "编辑欢迎消息", callback_data: "config:edit:welcome_msg" }],
            [{ text: "编辑验证问题", callback_data: "config:edit:verif_q" }],
            [{ text: "编辑验证答案", callback_data: "config:edit:verif_a" }],
            [{ text: "编辑屏蔽阈值", callback_data: "config:edit:block_threshold" }],
            [{ text: "返回主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 自动回复菜单
async function handleAdminAutoReplyMenu(chatId, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const rules = await getAutoReplyRules(env);
    let rulesText = rules.length === 0 ? "暂无规则" : rules.map((r, i) => `${i + 1}. <code>${escapeHtml(r.keywords)}</code> → <code>${escapeHtml(r.response.substring(0, 30))}...</code>`).join('\n');
    const menuText = `
<b>自动回复管理</b>
---
${rulesText}
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: "添加规则", callback_data: "config:add:keyword_responses" }],
            [{ text: "查看/删除规则", callback_data: "config:list:keyword_responses" }],
            [{ text: "返回主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 关键词屏蔽菜单
async function handleAdminKeywordMenu(chatId, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const keywords = await getBlockKeywords(env);
    let keywordsText = keywords.length === 0 ? "暂无关键词" : keywords.map((k, i) => `${i + 1}. <code>${escapeHtml(k)}</code>`).join('\n');
    const menuText = `
<b>关键词屏蔽管理</b>
---
${keywordsText}
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: "添加关键词", callback_data: "config:add:block_keywords" }],
            [{ text: "查看/删除关键词", callback_data: "config:list:block_keywords" }],
            [{ text: "返回主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 过滤菜单
async function handleAdminFilterMenu(chatId, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const settings = {
        enable_image_forwarding: await getConfig('enable_image_forwarding', env, 'true'),
        enable_link_forwarding: await getConfig('enable_link_forwarding', env, 'true'),
        enable_text_forwarding: await getConfig('enable_text_forwarding', env, 'true'),
        enable_channel_forwarding: await getConfig('enable_channel_forwarding', env, 'true'),
        enable_forward_forwarding: await getConfig('enable_forward_forwarding', env, 'true'),
        enable_audio_forwarding: await getConfig('enable_audio_forwarding', env, 'true'),
        enable_sticker_forwarding: await getConfig('enable_sticker_forwarding', env, 'true'),
    };
    const status = (v) => v === 'true' ? '✅' : '❌';
    const menuText = `
<b>按类型过滤管理</b>
---
媒体: ${status(settings.enable_image_forwarding)}
链接: ${status(settings.enable_link_forwarding)}
文本: ${status(settings.enable_text_forwarding)}
频道转发: ${status(settings.enable_channel_forwarding)}
任意转发: ${status(settings.enable_forward_forwarding)}
音频/语音: ${status(settings.enable_audio_forwarding)}
贴纸/GIF: ${status(settings.enable_sticker_forwarding))
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: `${status(settings.enable_image_forwarding)} 媒体`, callback_data: `config:toggle:enable_image_forwarding` }],
            [{ text: `${status(settings.enable_link_forwarding)} 链接`, callback_data: `config:toggle:enable_link_forwarding` }],
            [{ text: `${status(settings.enable_text_forwarding)} 文本`, callback_data: `config:toggle:enable_text_forwarding` }],
            [{ text: `${status(settings.enable_channel_forwarding)} 频道转发`, callback_data: `config:toggle:enable_channel_forwarding` }],
            [{ text: `${status(settings.enable_forward_forwarding)} 任意转发`, callback_data: `config:toggle:enable_forward_forwarding` }],
            [{ text: `${status(settings.enable_audio_forwarding)} 音频/语音`, callback_data: `config:toggle:enable_audio_forwarding` }],
            [{ text: `${status(settings.enable_sticker_forwarding)} 贴纸/GIF`, callback_data: `config:toggle:enable_sticker_forwarding` }],
            [{ text: "返回主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 协管员菜单
async function handleAdminAuthorizedMenu(chatId, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const admins = await getAuthorizedAdmins(env);
    const adminList = admins.length === 0 ? "暂无协管员" : admins.map(id => `<code>${id}</code>`).join(', ');
    const menuText = `
<b>协管员授权设置</b>
---
当前协管员: ${adminList}
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: "编辑协管员列表", callback_data: "config:edit:authorized_admins" }],
            [{ text: "返回主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 备份群组菜单
async function handleAdminBackupMenu(chatId, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    const backupId = await getConfig('backup_group_id', env, "未设置");
    const menuText = `
<b>备份群组设置</b>
---
当前备份群组: <code>${escapeHtml(backupId)}</code>
    `.trim();
    const keyboard = {
        inline_keyboard: [
            [{ text: "编辑备份群组", callback_data: "config:edit:backup_group_id" }],
            [{ text: "返回主菜单", callback_data: "config:menu" }],
        ]
    };
    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 规则列表（添加/删除）
async function handleAdminRuleList(chatId, type, env) {
    const lastMsgId = await dbAdminMenuMsgIdGet(chatId, env);
    let items = [];
    let title = "";
    if (type === "keyword_responses") {
        items = await getAutoReplyRules(env);
        title = "自动回复规则";
    } else if (type === "block_keywords") {
        items = await getBlockKeywords(env);
        title = "屏蔽关键词";
    }
    const listText = items.length === 0 ? "暂无项目" : items.map((item, i) => {
        if (type === "keyword_responses") {
            return `${i + 1}. <code>${escapeHtml(item.keywords)}</code> → <code>${escapeHtml(item.response.substring(0, 30))}...</code> [删除:${i}]`;
        } else {
            return `${i + 1}. <code>${escapeHtml(item)}</code> [删除:${i}]`;
        }
    }).join('\n');

    const menuText = `
<b>${title}</b>
---
${listText}
    `.trim();

    const keyboard = {
        inline_keyboard: items.map((_, i) => [{
            text: "删除",
            callback_data: `config:delete:${type}:${i}`
        }]).concat([[{ text: "返回", callback_data: `config:menu:${type === 'keyword_responses' ? 'autoreply' : 'keyword'}` }]])
    };

    const apiMethod = lastMsgId ? "editMessageText" : "sendMessage";
    const params = { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: keyboard };
    if (apiMethod === "editMessageText") params.message_id = lastMsgId;
    const result = await telegramApi(env.BOT_TOKEN, apiMethod, params);
    await dbAdminMenuMsgIdPut(chatId, result.message_id || lastMsgId, env);
}

// 输入处理
async function handleAdminConfigInput(userId, text, adminStateJson, env) {
    const adminState = JSON.parse(adminStateJson);
    if (text.toLowerCase() === "/cancel") {
        await dbAdminStateDelete(userId, env);
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: "编辑已取消。" });
        await handleAdminConfigStart(userId, env);
        return;
    }

    let successMsg = "配置已更新。";
    let nextMenuAction = null;

    if (adminState.action === 'awaiting_input') {
        let finalValue = text;
        if (['verif_a', 'block_threshold'].includes(adminState.key)) {
            finalValue = text.trim();
        } else if (adminState.key === 'backup_group_id') {
            finalValue = text.trim();
        } else if (adminState.key === 'authorized_admins') {
            const list = text.split(',').map(id => id.trim()).filter(id => id);
            finalValue = JSON.stringify(list);
        } else if (adminState.key === 'welcome_msg' || adminState.key === 'verif_q') {
            finalValue = text;
        }

        if (adminState.key.startsWith('add_')) {
            const type = adminState.key.replace('add_', '');
            const current = type === 'keyword_responses' ? await getAutoReplyRules(env) : await getBlockKeywords(env);
            if (type === 'keyword_responses') {
                const [keywords, ...responseParts] = text.split('\n');
                const response = responseParts.join('\n');
                current.push({ keywords, response });
            } else {
                current.push(text.trim());
            }
            finalValue = JSON.stringify(current);
            await dbConfigPut(type, finalValue, env);
            successMsg = "规则已添加。";
            nextMenuAction = type === 'keyword_responses' ? 'config:menu:autoreply' : 'config:menu:keyword';
        } else {
            await dbConfigPut(adminState.key, finalValue, env);
            successMsg = "配置已更新。";
            nextMenuAction = 'config:menu:base';
        }

        await telegramApi(env.BOT_TOKEN, "editMessageText", {
            chat_id: userId,
            message_id: adminState.prompt_message_id,
            text: successMsg,
            parse_mode: "HTML",
        });

        await dbAdminStateDelete(userId, env);

        if (nextMenuAction) {
            const [_, menu, sub] = nextMenuAction.split(':');
            if (menu === 'menu' && sub === 'base') await handleAdminBaseConfigMenu(userId, env);
            else if (menu === 'menu' && sub === 'autoreply') await handleAdminAutoReplyMenu(userId, env);
            else if (menu === 'menu' && sub === 'keyword') await handleAdminKeywordMenu(userId, env);
        }
    }
}

// 回调查询
async function handleCallbackQuery(callbackQuery, env) {
    const { data, message, from: user } = callbackQuery;
    const chatId = message.chat.id.toString();
    const isPrimary = isPrimaryAdmin(user.id, env);

    if (data.startsWith('config:')) {
        if (!isPrimary) {
            await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "无权限。", show_alert: true });
            return;
        }

        const parts = data.split(':');
        const action = parts[1];
        const sub = parts[2];
        const value = parts[3];

        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id });

        if (action === 'menu') {
            if (sub === 'base') await handleAdminBaseConfigMenu(chatId, env);
            else if (sub === 'autoreply') await handleAdminAutoReplyMenu(chatId, env);
            else if (sub === 'keyword') await handleAdminKeywordMenu(chatId, env);
            else if (sub === 'filter') await handleAdminFilterMenu(chatId, env);
            else if (sub === 'authorized') await handleAdminAuthorizedMenu(chatId, env);
            else if (sub === 'backup') await handleAdminBackupMenu(chatId, env);
            else await handleAdminConfigStart(chatId, env);
        } else if (action === 'edit' && sub) {
            const prompt = {
                welcome_msg: "请输入新的欢迎消息：",
                verif_q: "请输入新的验证问题：",
                verif_a: "请输入新的验证答案：",
                block_threshold: "请输入新的屏蔽阈值（数字）：",
                backup_group_id: "请输入备份群组ID或@username：",
                authorized_admins: "请输入协管员ID列表，用逗号分隔：",
            }[sub] || "请输入新值：";

            const sent = await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: chatId,
                text: prompt + "\n\n发送 /cancel 取消",
                reply_markup: { force_reply: true }
            });

            await dbAdminStatePut(chatId, JSON.stringify({
                action: 'awaiting_input',
                key: sub,
                prompt_message_id: sent.message_id
            }), env);
        } else if (action === 'toggle' && sub) {
            const current = await getConfig(sub, env, 'false');
            await dbConfigPut(sub, current === 'true' ? 'false' : 'true', env);
            await handleAdminFilterMenu(chatId, env);
        } else if (action === 'add' && sub) {
            const prompt = sub === 'keyword_responses' ? "请输入关键词（正则）和回复，用换行分隔：\n关键词\n回复内容" : "请输入要屏蔽的关键词（正则）：";
            const sent = await telegramApi(env.BOT_TOKEN, "sendMessage", {
                chat_id: chatId,
                text: prompt + "\n\n发送 /cancel 取消",
                reply_markup: { force_reply: true }
            });
            await dbAdminStatePut(chatId, JSON.stringify({
                action: 'awaiting_input',
                key: `add_${sub}`,
                prompt_message_id: sent.message_id
            }), env);
        } else if (action === 'list' && sub) {
            await handleAdminRuleList(chatId, sub, env);
        } else if (action === 'delete' && sub && value !== undefined) {
            const index = parseInt(value);
            const type = sub;
            const current = type === 'keyword_responses' ? await getAutoReplyRules(env) : await getBlockKeywords(env);
            if (index >= 0 && index < current.length) {
                current.splice(index, 1);
                await dbConfigPut(type, JSON.stringify(current), env);
            }
            await handleAdminRuleList(chatId, type, env);
        }
        return;
    }

    // 屏蔽/解禁/置顶
    if (data.startsWith('block:') || data.startsWith('unblock:')) {
        const userId = data.split(':')[1];
        if (data.startsWith('block:')) await handleBlockUser(userId, message, env);
        else await handleUnblockUser(userId, message, env);
    } else if (data.startsWith('pin_card:')) {
        await handlePinCard(callbackQuery, message, env);
    }
}

async function handleBlockUser(userId, message, env) {
    await dbUserUpdate(userId, { is_blocked: true }, env);
    const userData = await dbUserGetOrCreate(userId, env);
    const userName = userData.user_info ? userData.user_info.name : `User ${userId}`;
    await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: message.chat.id, message_id: message.message_id, reply_markup: getInfoCardButtons(userId, true)
    });
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, text: `用户 [${userName}] 已被屏蔽。`, message_thread_id: message.message_thread_id, parse_mode: "Markdown"
    });
}

async function handleUnblockUser(userId, message, env) {
    await dbUserUpdate(userId, { is_blocked: false, block_count: 0 }, env);
    const userData = await dbUserGetOrCreate(userId, env);
    const userName = userData.user_info ? userData.user_info.name : `User ${userId}`;
    await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
        chat_id: message.chat.id, message_id: message.message_id, reply_markup: getInfoCardButtons(userId, false)
    });
    await telegramApi(env.BOT_TOKEN, "sendMessage", {
        chat_id: message.chat.id, text: `用户 [${userName}] 已解除屏蔽。`, message_thread_id: message.message_thread_id, parse_mode: "Markdown"
    });
}

async function handlePinCard(callbackQuery, message, env) {
    try {
        await telegramApi(env.BOT_TOKEN, "pinChatMessage", {
            chat_id: message.chat.id, message_id: message.message_id, message_thread_id: message.message_thread_id, disable_notification: true
        });
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: "置顶成功。" });
    } catch (e) {
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: callbackQuery.id, text: `置顶失败: ${e.message}`, show_alert: true });
    }
}

async function handleAdminReply(message, env) {
    if (!message.is_topic_message || !message.message_thread_id) return;
    if (message.chat.id.toString() !== env.ADMIN_GROUP_ID.toString()) return;
    if (message.from?.is_bot) return;
    const senderId = message.from.id.toString();
    const isAuthorizedAdmin = await isAdminUser(senderId, env);
    if (!isAuthorizedAdmin) return;
    const topicId = message.message_thread_id.toString();
    const userId = await dbTopicUserGet(topicId, env);
    if (!userId) return;
    try {
        await telegramApi(env.BOT_TOKEN, "copyMessage", {
            chat_id: userId,
            from_chat_id: message.chat.id,
            message_id: message.message_id,
        });
    } catch (e) {
        console.error("回复失败:", e);
    }
}
