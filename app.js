require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const cron = require('node-cron');

admin.initializeApp({ projectId: 'ig-update-listener' });
const fireStore = getFirestore();

const app = express();
app.use(express.json());

// Health check
app.get('/', (req, res) => {
    res.send('ig-telegram-bot is running');
});

// Manual trigger to check instagram updates
app.get('/checkInstagramUpdate', async (req, res) => {
    try {
        await getStories();
        await getMedia();
        res.sendStatus(200);
    } catch (err) {
        console.error('Check update error:', err.message);
        res.status(500).send(err.message);
    }
});

const TG = (method) => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`;

const getListeners = async () => {
    const listeners = [];
    const snapshot = await fireStore.collection("listeners").get();
    snapshot.forEach(doc => listeners.push(doc.data()));
    return listeners;
};

// --- Instagram stories logic (ephemeral; only currently-live stories) ---

// Per-user marker: story ids already pushed are recorded in users/<id>.sentStoryIds,
// so a story that is still live on the next run is not re-sent. Without this, every run
// re-pushed every currently-live story (stories stay live ~24h > the daily cron cadence).
const STORY_ID_HISTORY = 100; // cap so the marker can't grow unbounded

const getStories = async () => {
    const userDocs = [];
    const snapshot = await fireStore.collection("users").get();
    snapshot.forEach(doc => userDocs.push(doc));

    const listeners = await getListeners();

    for (const doc of userDocs) {
        const user = doc.data();

        const { data: { data: stories } } = await axios({
            url: `https://graph.facebook.com/${user.ig_user_id}/stories`,
            method: 'get',
            params: {
                access_token: user.access_token,
                fields: ['id', 'media_product_type', 'media_type', 'media_url', 'timestamp'].join(',')
            },
        });

        const sent = user.sentStoryIds || [];
        const sentSet = new Set(sent);
        const fresh = (stories || []).filter(s => !sentSet.has(s.id));

        if (fresh.length === 0) continue;

        for (const story of fresh) {
            await sendStory(story, listeners);
        }

        // keep only the most recent ids; expired story ids will never reappear
        const updatedIds = [...sent, ...fresh.map(s => s.id)].slice(-STORY_ID_HISTORY);
        await doc.ref.update({ sentStoryIds: updatedIds });
        console.log(`Pushed ${fresh.length} new story(ies) for ${user.ig_user_id}`);
    }
};

const sendStory = async (story, listeners) => {
    // Graph API returns media_type as IMAGE / VIDEO for stories
    const type = (story.media_type || '').toLowerCase();
    for (const listener of listeners) {
        try {
            if (type === 'video') {
                await axios.post(TG('sendVideo'), {
                    chat_id: listener.chat_id,
                    video: story.media_url,
                    disable_notification: false,
                });
            } else if (type === 'image' || type === 'photo') {
                await axios.post(TG('sendPhoto'), {
                    chat_id: listener.chat_id,
                    photo: story.media_url,
                    disable_notification: false,
                });
            }
        } catch (err) {
            // one oversized/expired story must not abort the whole run
            const detail = err.response?.data?.description || err.message;
            console.error(`sendStory failed for chat ${listener.chat_id}: ${detail}`);
        }
    }
};

// --- Instagram feed posts logic (permanent; tracks what was already sent) ---

// Per-user marker: only posts newer than users/<id>.lastSentMediaTs are pushed.
const getMedia = async () => {
    const userDocs = [];
    const snapshot = await fireStore.collection("users").get();
    snapshot.forEach(doc => userDocs.push(doc));

    const listeners = await getListeners();

    for (const doc of userDocs) {
        const user = doc.data();
        const since = user.lastSentMediaTs || 0;

        // newest-first; the most recent posts are all on the first page(s)
        const { data: { data: media } } = await axios({
            url: `https://graph.facebook.com/${user.ig_user_id}/media`,
            method: 'get',
            params: {
                access_token: user.access_token,
                fields: 'id,caption,media_type,media_url,permalink,timestamp,children{media_type,media_url}',
                limit: 50,
            },
        });

        const fresh = (media || [])
            .filter(m => Date.parse(m.timestamp) > since)
            .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); // oldest -> newest

        if (fresh.length === 0) continue;

        // Throttle heavy backfills: at most MAX_MEDIA_PER_RUN per run (cron runs every 12h).
        // The oldest fresh posts go first; the rest are picked up on the next run.
        const batch = fresh.slice(0, MAX_MEDIA_PER_RUN);

        for (const post of batch) {
            await sendPost(post, listeners);
        }

        const newest = Math.max(...batch.map(m => Date.parse(m.timestamp)));
        await doc.ref.update({ lastSentMediaTs: newest });
        console.log(`Pushed ${batch.length}/${fresh.length} new post(s) for ${user.ig_user_id}, marker -> ${new Date(newest).toISOString()}`);
    }
};

// Heavy-backfill throttle: max posts sent per run; cron cadence is every 12h => 6 per 12h.
const MAX_MEDIA_PER_RUN = 6;

const formatPostDate = (timestamp) =>
    new Date(timestamp).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    });

const sendPost = async (post, listeners) => {
    const header = `🗓 ${formatPostDate(post.timestamp)}`;
    const cap = (post.caption || '').slice(0, 850);
    const caption = `${header}\n\n${cap}${cap ? '\n\n' : ''}${post.permalink}`;
    // carousels expose no top-level media_url; use the first child
    const photoUrl = post.media_url || post.children?.data?.[0]?.media_url;
    const firstChildType = post.children?.data?.[0]?.media_type;

    for (const listener of listeners) {
        try {
            if (post.media_type === 'VIDEO') {
                await axios.post(TG('sendVideo'), { chat_id: listener.chat_id, video: post.media_url, caption });
            } else if (post.media_type === 'IMAGE' || firstChildType === 'IMAGE' || post.media_type === 'CAROUSEL_ALBUM') {
                await axios.post(TG('sendPhoto'), { chat_id: listener.chat_id, photo: photoUrl, caption });
            } else {
                await axios.post(TG('sendMessage'), { chat_id: listener.chat_id, text: caption });
            }
        } catch (err) {
            // media URLs can exceed Telegram's URL-fetch limits; fall back to a plain link
            const detail = err.response?.data?.description || err.message;
            console.error(`sendPost media failed (${detail}), falling back to link for chat ${listener.chat_id}`);
            try {
                await axios.post(TG('sendMessage'), { chat_id: listener.chat_id, text: caption });
            } catch (e2) {
                console.error(`sendPost link fallback also failed for chat ${listener.chat_id}:`, e2.response?.data?.description || e2.message);
            }
        }
    }
};

// --- Telegram bot ---

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.catch((err, ctx) => {
    console.error('[Bot] Error', err);
    return ctx.reply(`Ooops, encountered an error for ${ctx.updateType}`);
});

bot.command('start', (ctx) => ctx.reply('Hi! Type /subscribe to be notified on Instagram updates.'));
bot.command('subscribe', async (ctx) => {
    await fireStore.doc("listeners/" + ctx.chat.id).set({
        chat_id: ctx.chat.id,
        subscribed: true
    });
    ctx.reply('You are subscribed now.');
});

// --- Start ---

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);

    // NOTE: do not await — Telegraf v4's launch() resolves only when the bot STOPS,
    // so awaiting it blocks the cron registration below from ever running.
    bot.launch();
    console.log('Telegram bot started (polling)');

    // Schedule story + feed-post checks daily at 09:00 UTC.
    // getMedia caps at MAX_MEDIA_PER_RUN per run, so heavy backfills trickle out (6 / day).
    cron.schedule('0 9 * * *', async () => {
        console.log('Running scheduled update check...');
        try {
            await getStories();
            await getMedia();
            console.log('Scheduled update check complete');
        } catch (err) {
            console.error('Scheduled update check failed:', err.message);
        }
    }, { timezone: 'UTC' });
    console.log('Scheduled update check daily at 09:00 UTC');
});

process.on('SIGINT', () => {
    bot.stop('SIGINT');
    process.exit();
});
process.on('SIGTERM', () => {
    bot.stop('SIGTERM');
    process.exit();
});
