const querystring = require('querystring');
const got = require('@/utils/got');
const config = require('@/config').value;
const weiboUtils = require('./utils');
const timezone = require('@/utils/timezone');
const { fallback, queryToBoolean } = require('@/utils/readable-social');

module.exports = async (ctx) => {
    const uid = ctx.params.uid;
    const feature = ctx.params.feature || 0;
    const routeParams = ctx.params.routeParams || undefined;
    const token = await ctx.cache.get('weibotimelineuid' + uid, false);
    let displayVideo = '1';
    if (routeParams) {
        if (routeParams === '1' || routeParams === '0') {
            displayVideo = routeParams;
        } else {
            const routeParams = querystring.parse(ctx.params.routeParams);
            displayVideo = fallback(undefined, queryToBoolean(routeParams.displayVideo), true) ? '1' : '0';
        }
    }

    if (token) {
        const containerResponse = await got({
            method: 'get',
            url: `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}`,
            headers: {
                Referer: 'https://m.weibo.cn/',
            },
        });
        const name = containerResponse.data.data.userInfo.screen_name;
        const description = containerResponse.data.data.userInfo.description;
        const profileImageUrl = containerResponse.data.data.userInfo.profile_image_url;

        const response = await got.get(`https://api.weibo.com/2/statuses/home_timeline.json?access_token=${token}&count=100&feature=${feature}`);
        // 检查token失效
        if (response.data.error !== undefined) {
            const { app_key = '', redirect_url = ctx.request.origin + '/weibo/timeline/0' } = config.weibo;

            ctx.status = 302;
            ctx.set({
                'Cache-Control': 'no-cache',
            });
            ctx.redirect(`https://api.weibo.com/oauth2/authorize?client_id=${app_key}&redirect_uri=${redirect_url}${routeParams ? `&state=${routeParams}` : ''}`);
        }
        const resultItem = await Promise.all(
            response.data.statuses.map(async (item) => {
                let data = {};
                const key = `weibotimelineurl${item.user.id}${item.id}`;
                const value = await ctx.cache.get(key);
                if (value) {
                    data = JSON.parse(value);
                } else {
                    data = await weiboUtils.getShowData(uid, item.id);
                    ctx.cache.set(key, JSON.stringify(data));
                }

                // 是否通过api拿到了data
                const isDataOK = data !== undefined && data.text;
                if (isDataOK) {
                    item = data;
                }

                // 转发的长微博处理
                const retweet = item.retweeted_status;
                if (retweet && retweet.isLongText) {
                    const retweetData = await weiboUtils.getShowData(retweet.user.id, retweet.id);
                    if (retweetData !== undefined && retweetData.text) {
                        item.retweeted_status.text = retweetData.text;
                    }
                }

                const link = `https://weibo.com/${uid}/${item.id}`;

                const formatExtended = weiboUtils.formatExtended(ctx, item);
                let description = formatExtended.description;
                const title = formatExtended.title;
                const pubDate = isDataOK ? new Date(data.created_at) : timezone(item.created_at, +8);

                // 视频的处理
                if (displayVideo === '1') {
                    description = weiboUtils.formatVideo(description, item);
                }

                const it = {
                    title: title,
                    description: description,
                    link: link,
                    pubDate: pubDate,
                    author: item.user.screen_name,
                };
                return Promise.resolve(it);
            })
        );

        ctx.state.data = {
            title: `个人微博时间线--${name}`,
            link: `http://weibo.com/${uid}/`,
            description: description,
            image: profileImageUrl,
            item: resultItem,
        };
    } else if (uid === '0' || ctx.querystring) {
        const { app_key = '', redirect_url = ctx.request.origin + '/weibo/timeline/0', app_secret = '' } = config.weibo;

        const code = ctx.query.code;
        const routeParams = ctx.query.state;
        if (code) {
            const rep = await got.post(`https://api.weibo.com/oauth2/access_token?client_id=${app_key}&client_secret=${app_secret}&code=${code}&redirect_uri=${redirect_url}&grant_type=authorization_code`);
            const token = rep.data.access_token;
            const uid = rep.data.uid;
            const expires_in = rep.data.expires_in;
            await ctx.cache.set('weibotimelineuid' + uid, token, expires_in, false);

            ctx.set({
                'Content-Type': 'text/html; charset=UTF-8',
                'Cache-Control': 'no-cache',
            });
            ctx.body = `<script>window.location = '/weibo/timeline/${uid}${routeParams ? `/${routeParams}` : ''}'</script>`;
        }
    } else {
        const { app_key = '', redirect_url = ctx.request.origin + '/weibo/timeline/0' } = config.weibo;

        ctx.status = 302;
        ctx.set({
            'Cache-Control': 'no-cache',
        });
        ctx.redirect(`https://api.weibo.com/oauth2/authorize?client_id=${app_key}&redirect_uri=${redirect_url}${routeParams ? `&state=${feature}/${routeParams.replace(/&/g, '%26')}` : ''}`);
    }
};
