const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require('cors')({origin: true}); 
const axios = require("axios");
admin.initializeApp();
const fireStore = admin.firestore();
const queryString = require('query-string');
const { Telegraf } = require('telegraf');

var redirect_uri = process.env.INSTANGRAM_BASE_URL + '/auth';

exports.authorizeUser = functions.https.onRequest((request, response) => {
    const stringifiedParams = queryString.stringify({
        client_id: process.env.FACEBOOK_CLIENT_ID,
        redirect_uri,
        scope: ['email', 'instagram_basic', 'instagram_manage_insights', 'pages_read_engagement', 'pages_show_list'].join(','), // comma seperated string // 'user_profile','user_media', , 'instagram_graph_user_profile', 'instagram_graph_user_media'
        response_type: 'code',
        auth_type: 'rerequest',
        display: 'popup',
        state: ''
    });

    const facebookLoginUrl = `https://www.facebook.com/dialog/oauth?${stringifiedParams}`;
    response.redirect(facebookLoginUrl);
});

exports.auth = functions.https.onRequest(async (request, response) => {
    const authCode = request.query.code;

    cors(request, response, async () => {
        const { data: { access_token } } = await axios({
            url: 'https://graph.facebook.com/oauth/access_token',
            method: 'get',
            params: {
                client_id: process.env.FACEBOOK_CLIENT_ID,
                client_secret: process.env.FACEBOOK_CLIENT_SECRET,
                redirect_uri,
                code: authCode,
            },
        });
        console.log(access_token);
        
        // get long lived access token
        const { data: { access_token: longLivedAccessToken, expires_in } } = await axios({
            url: 'https://graph.facebook.com/oauth/access_token',
            method: 'get',
            params: {
                grant_type: 'fb_exchange_token',
                client_id: process.env.FACEBOOK_CLIENT_ID,
                client_secret: process.env.FACEBOOK_CLIENT_SECRET,
                fb_exchange_token: access_token,
            },
        });
        console.log(longLivedAccessToken, expires_in);

        // get the current user id
        const { data: { id: user_id } } = await axios({
            url: 'https://graph.facebook.com/me',
            method: 'get',
            params: {
                access_token,
            },
        });
        console.log(user_id);

        // controlled business account
        const { data: businessAccounts } = await axios({
            url: 'https://graph.facebook.com/me/accounts',
            method: 'get',
            params: {
                access_token,
            },
        });
        const page_id = businessAccounts.data[0].id;
        const page_access_token = businessAccounts.data[0].access_token;
        console.log(page_id, page_access_token);

        // linked ig account
        const { data: { instagram_business_account: { id: ig_user_id } } } = await axios({
            url: `https://graph.facebook.com/${page_id}`,
            method: 'get',
            params: {
                access_token,
                fields: 'instagram_business_account'
            },
        });
        console.log(ig_user_id);

        await fireStore.doc("users/" + user_id).set({
            user_id,
            page_id,
            ig_user_id,
            access_token: longLivedAccessToken,
            page_access_token,
            expires: Date.now() + expires_in
        })

        response.redirect(process.env.WEB_APP_URL)
    })
});

exports.checkInstagramUpdate = functions.https.onRequest(async (request, response) => {
    cors(request, response, async () => {
        await getStories()
        response.send(200)
    })
});

exports.scheduledUpdates = functions.pubsub.schedule('every 24 hours').onRun((context) => {
    getStories();
    return null;
  });

const getStories = async () => {
    const users = []
    await fireStore.collection("users").get().then(snapshot => {
        snapshot.forEach(doc => {
            users.push(doc.data())
        });
    })
    await Promise.all(users.map(async user => {
        const { data: { data: stories} } = await axios({
            url: `https://graph.facebook.com/${user.ig_user_id}/stories`,
            method: 'get',
            params: {
                access_token: user.access_token,
                fields: ['id','media_product_type','media_type','media_url','timestamp'].join(',')
            },
        });
        await sendUpdateEmail(stories)
    }))
}

const sendUpdateEmail = async (stories) => {
    const listeners = []
    await fireStore.collection("listeners").get().then(snapshot => {
        snapshot.forEach(doc => {
            listeners.push(doc.data())
        });
    })
    await Promise.all(listeners.map(async listener => {
        await Promise.all(stories.map(async ({
            media_type, media_url
        }) => {
            switch (media_type.toLowerCase()) {
                case 'photo': return await axios({
                    url: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendPhoto`,
                    method: 'post',
                    headers: {
                        accept: 'application/json',
                        'User-Agent': 'Telegram Bot SDK - (https://github.com/irazasyed/telegram-bot-sdk)',
                        'content-type': 'application/json'
                    },
                    data: {
                        chat_id: listener.chat_id,
                        photo: media_url,
                        // caption: null,
                        disable_notification: false,
                        reply_to_message_id: null
                    }
                });
                case 'video': return await axios({
                    url: `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendVideo`,
                    method: 'post',
                    headers: {
                        accept: 'application/json',
                        'User-Agent': 'Telegram Bot SDK - (https://github.com/irazasyed/telegram-bot-sdk)',
                        'content-type': 'application/json'
                    },
                    data: {
                        chat_id: listener.chat_id,
                        video: media_url,
                        // caption: null,
                        disable_notification: false,
                        reply_to_message_id: null
                    }
                });
            }
        }))
    }))
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, {
	telegram: { webhookReply: true },
})

// error handling
bot.catch((err, ctx) => {
	functions.logger.error('[Bot] Error', err)
	return ctx.reply(`Ooops, encountered an error for ${ctx.updateType}`, err)
})

// initialize the commands
bot.command('/start', (ctx) => ctx.reply('Hi! Type /subscribe to be notified on Instagram updates.'))
bot.command('/subscribe', async (ctx) => {
    await fireStore.doc("listeners/" + ctx.chat.id).set({
        chat_id: ctx.chat.id,
        subscribed: true
    })
    ctx.reply('You are subscribed now.')
})
// copy every message and send to the user
// bot.on('message', async (ctx) => {
//     await fireStore.doc("listeners/" + ctx.chat.id).set(true)
// })

// handle all telegram updates with HTTPs trigger
exports.telegramBot = functions.https.onRequest(async (request, response) => {
	return await bot.handleUpdate(request.body, response).then((rv) => {
		// if it's not a request from the telegram, rv will be undefined, but we should respond with 200
		return !rv && response.sendStatus(200)
	})
})