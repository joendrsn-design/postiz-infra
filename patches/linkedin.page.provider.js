"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinkedinPageProvider = void 0;
const tslib_1 = require("tslib");
const make_is_1 = require("../../services/make.is");
const linkedin_provider_1 = require("./linkedin.provider");
const dayjs_1 = tslib_1.__importDefault(require("dayjs"));
const plug_decorator_1 = require("../../../../helpers/src/decorators/plug.decorator");
const timer_1 = require("../../../../helpers/src/utils/timer");
const rules_description_decorator_1 = require("../../chat/rules.description.decorator");
let LinkedinPageProvider = class LinkedinPageProvider extends linkedin_provider_1.LinkedinProvider {
    constructor() {
        super(...arguments);
        this.identifier = 'linkedin-page';
        this.name = 'LinkedIn Page';
        this.isBetweenSteps = true;
        this.refreshWait = true;
        this.maxConcurrentJob = 2;
        this.scopes = [
            'w_member_social',
            'r_basicprofile',
            'rw_organization_admin',
            'w_organization_social',
            'r_organization_social',
        ];
        this.editor = 'normal';
    }
    async refreshToken(refresh_token) {
        const { access_token: accessToken, expires_in, refresh_token: refreshToken, } = await (await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token,
                client_id: process.env.LINKEDIN_CLIENT_ID,
                client_secret: process.env.LINKEDIN_CLIENT_SECRET,
            }),
        })).json();
        const { id, vanityName, localizedFirstName, localizedLastName, } = await (await fetch('https://api.linkedin.com/rest/me', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'X-Restli-Protocol-Version': '2.0.0',
                'LinkedIn-Version': '202601',
            },
        })).json();
        const name = [localizedFirstName, localizedLastName].filter(Boolean).join(' ') || undefined;
        const picture = undefined;
        return {
            id,
            accessToken,
            refreshToken,
            expiresIn: expires_in,
            name,
            picture,
            username: vanityName,
        };
    }
    async addComment(integration, originalIntegration, postId, information) {
        return super.addComment(integration, originalIntegration, postId, information, false);
    }
    async repostPostUsers(integration, originalIntegration, postId, information) {
        return super.repostPostUsers(integration, originalIntegration, postId, information, false);
    }
    async generateAuthUrl() {
        const state = (0, make_is_1.makeId)(6);
        const codeVerifier = (0, make_is_1.makeId)(30);
        const url = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${process.env.LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${process.env.FRONTEND_URL}/integrations/social/linkedin-page`)}&state=${state}&scope=${encodeURIComponent(this.scopes.join(' '))}`;
        return {
            url,
            codeVerifier,
            state,
        };
    }
    async companies(accessToken) {
        const { elements, ...all } = await (await fetch('https://api.linkedin.com/v2/organizationalEntityAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organizationalTarget~(localizedName,vanityName,logoV2(original~:playableStreams))))', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'X-Restli-Protocol-Version': '2.0.0',
                'LinkedIn-Version': '202601',
            },
        })).json();
        return (elements || []).map((e) => ({
            id: e.organizationalTarget.split(':').pop(),
            page: e.organizationalTarget.split(':').pop(),
            username: e['organizationalTarget~'].vanityName,
            name: e['organizationalTarget~'].localizedName,
            picture: e['organizationalTarget~'].logoV2?.['original~']?.elements?.[0]
                ?.identifiers?.[0]?.identifier,
        }));
    }
    async reConnect(id, requiredId, accessToken) {
        const information = await this.fetchPageInformation(accessToken, {
            page: requiredId,
        });
        return {
            id: information.id,
            name: information.name,
            accessToken: information.access_token,
            picture: information.picture,
            username: information.username,
        };
    }
    async fetchPageInformation(accessToken, params) {
        const pageId = params.page;
        const data = await (await fetch(`https://api.linkedin.com/v2/organizations/${pageId}?projection=(id,localizedName,vanityName,logoV2(original~:playableStreams))`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })).json();
        return {
            id: data.id,
            name: data.localizedName,
            access_token: accessToken,
            picture: data?.logoV2?.['original~']?.elements?.[0]?.identifiers?.[0].identifier,
            username: data.vanityName,
        };
    }
    async authenticate(params) {
        const body = new URLSearchParams();
        body.append('grant_type', 'authorization_code');
        body.append('code', params.code);
        body.append('redirect_uri', `${process.env.FRONTEND_URL}/integrations/social/linkedin-page`);
        body.append('client_id', process.env.LINKEDIN_CLIENT_ID);
        body.append('client_secret', process.env.LINKEDIN_CLIENT_SECRET);
        const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken, scope, } = await (await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        })).json();
        this.checkScopes(this.scopes, scope);
        const { id, vanityName, localizedFirstName, localizedLastName, } = await (await fetch('https://api.linkedin.com/rest/me', {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'X-Restli-Protocol-Version': '2.0.0',
                'LinkedIn-Version': '202601',
            },
        })).json();
        const name = [localizedFirstName, localizedLastName].filter(Boolean).join(' ') || undefined;
        const picture = undefined;
        return {
            id: id,
            accessToken,
            refreshToken,
            expiresIn,
            name,
            picture,
            username: vanityName,
        };
    }
    async post(id, accessToken, postDetails, integration) {
        return super.post(id, accessToken, postDetails, integration, 'company');
    }
    async comment(id, postId, lastCommentId, accessToken, postDetails, integration) {
        return super.comment(id, postId, lastCommentId, accessToken, postDetails, integration, 'company');
    }
    async analytics(id, accessToken, date) {
        const endDate = (0, dayjs_1.default)().unix() * 1000;
        const startDate = (0, dayjs_1.default)().subtract(date, 'days').unix() * 1000;
        const { elements } = await (await fetch(`https://api.linkedin.com/v2/organizationPageStatistics?q=organization&organization=${encodeURIComponent(`urn:li:organization:${id}`)}&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Linkedin-Version': '202601',
                'X-Restli-Protocol-Version': '2.0.0',
            },
        })).json();
        const { elements: elements2 } = await (await fetch(`https://api.linkedin.com/v2/organizationalEntityFollowerStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(`urn:li:organization:${id}`)}&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Linkedin-Version': '202601',
                'X-Restli-Protocol-Version': '2.0.0',
            },
        })).json();
        const { elements: elements3 } = await (await fetch(`https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(`urn:li:organization:${id}`)}&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Linkedin-Version': '202601',
                'X-Restli-Protocol-Version': '2.0.0',
            },
        })).json();
        const analytics = [...elements2, ...elements, ...elements3].reduce((all, current) => {
            if (typeof current?.totalPageStatistics?.views?.allPageViews
                ?.pageViews !== 'undefined') {
                all['Page Views'].push({
                    total: current.totalPageStatistics.views.allPageViews.pageViews,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
            }
            if (typeof current?.followerGains?.organicFollowerGain !== 'undefined') {
                all['Organic Followers'].push({
                    total: current?.followerGains?.organicFollowerGain,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
            }
            if (typeof current?.followerGains?.paidFollowerGain !== 'undefined') {
                all['Paid Followers'].push({
                    total: current?.followerGains?.paidFollowerGain,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
            }
            if (typeof current?.totalShareStatistics !== 'undefined') {
                all['Clicks'].push({
                    total: current?.totalShareStatistics.clickCount,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
                all['Shares'].push({
                    total: current?.totalShareStatistics.shareCount,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
                all['Engagement'].push({
                    total: current?.totalShareStatistics.engagement,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
                all['Comments'].push({
                    total: current?.totalShareStatistics.commentCount,
                    date: (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD'),
                });
            }
            return all;
        }, {
            'Page Views': [],
            Clicks: [],
            Shares: [],
            Engagement: [],
            Comments: [],
            'Organic Followers': [],
            'Paid Followers': [],
        });
        return Object.keys(analytics).map((key) => ({
            label: key,
            data: analytics[key],
            percentageChange: 5,
        }));
    }
    async postAnalytics(integrationId, accessToken, postId, date) {
        const endDate = (0, dayjs_1.default)().unix() * 1000;
        const startDate = (0, dayjs_1.default)().subtract(date, 'days').unix() * 1000;
        const shareStatsUrl = `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(`urn:li:organization:${integrationId}`)}&shares=List(${encodeURIComponent(postId)})&timeIntervals=(timeRange:(start:${startDate},end:${endDate}),timeGranularityType:DAY)`;
        const { elements: shareElements } = await (await this.fetch(shareStatsUrl, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'LinkedIn-Version': '202601',
                'X-Restli-Protocol-Version': '2.0.0',
            },
        })).json();
        let socialActions = null;
        try {
            const socialActionsUrl = `https://api.linkedin.com/v2/socialActions/${encodeURIComponent(postId)}`;
            socialActions = await (await this.fetch(socialActionsUrl, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'LinkedIn-Version': '202601',
                    'X-Restli-Protocol-Version': '2.0.0',
                },
            })).json();
        }
        catch (e) {
        }
        const analytics = (shareElements || []).reduce((all, current) => {
            if (typeof current?.totalShareStatistics !== 'undefined') {
                const dateStr = (0, dayjs_1.default)(current.timeRange.start).format('YYYY-MM-DD');
                all['Impressions'].push({
                    total: current.totalShareStatistics.impressionCount || 0,
                    date: dateStr,
                });
                all['Unique Impressions'].push({
                    total: current.totalShareStatistics.uniqueImpressionsCount || 0,
                    date: dateStr,
                });
                all['Clicks'].push({
                    total: current.totalShareStatistics.clickCount || 0,
                    date: dateStr,
                });
                all['Likes'].push({
                    total: current.totalShareStatistics.likeCount || 0,
                    date: dateStr,
                });
                all['Comments'].push({
                    total: current.totalShareStatistics.commentCount || 0,
                    date: dateStr,
                });
                all['Shares'].push({
                    total: current.totalShareStatistics.shareCount || 0,
                    date: dateStr,
                });
                all['Engagement'].push({
                    total: current.totalShareStatistics.engagement || 0,
                    date: dateStr,
                });
            }
            return all;
        }, {
            Impressions: [],
            'Unique Impressions': [],
            Clicks: [],
            Likes: [],
            Comments: [],
            Shares: [],
            Engagement: [],
        });
        if (Object.values(analytics).every((arr) => arr.length === 0) &&
            socialActions) {
            const today = (0, dayjs_1.default)().format('YYYY-MM-DD');
            analytics['Likes'].push({
                total: socialActions.likesSummary?.totalLikes || 0,
                date: today,
            });
            analytics['Comments'].push({
                total: socialActions.commentsSummary?.totalFirstLevelComments || 0,
                date: today,
            });
        }
        const result = Object.entries(analytics)
            .filter(([_, data]) => data.length > 0)
            .map(([label, data]) => ({
            label,
            data,
            percentageChange: 0,
        }));
        return result;
    }
    async autoRepostPost(integration, id, fields) {
        const { likesSummary: { totalLikes }, } = await (await this.fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: {
                'X-Restli-Protocol-Version': '2.0.0',
                'Content-Type': 'application/json',
                'LinkedIn-Version': '202601',
                Authorization: `Bearer ${integration.token}`,
            },
        })).json();
        if (totalLikes >= +fields.likesAmount) {
            await (0, timer_1.timer)(2000);
            await this.fetch(`https://api.linkedin.com/rest/posts`, {
                body: JSON.stringify({
                    author: `urn:li:organization:${integration.internalId}`,
                    commentary: '',
                    visibility: 'PUBLIC',
                    distribution: {
                        feedDistribution: 'MAIN_FEED',
                        targetEntities: [],
                        thirdPartyDistributionChannels: [],
                    },
                    lifecycleState: 'PUBLISHED',
                    isReshareDisabledByAuthor: false,
                    reshareContext: {
                        parent: id,
                    },
                }),
                method: 'POST',
                headers: {
                    'X-Restli-Protocol-Version': '2.0.0',
                    'Content-Type': 'application/json',
                    'LinkedIn-Version': '202601',
                    Authorization: `Bearer ${integration.token}`,
                },
            });
            return true;
        }
        return false;
    }
    async autoPlugPost(integration, id, fields) {
        const { likesSummary: { totalLikes }, } = await (await this.fetch(`https://api.linkedin.com/v2/socialActions/${encodeURIComponent(id)}`, {
            method: 'GET',
            headers: {
                'X-Restli-Protocol-Version': '2.0.0',
                'Content-Type': 'application/json',
                'LinkedIn-Version': '202601',
                Authorization: `Bearer ${integration.token}`,
            },
        })).json();
        if (totalLikes >= fields.likesAmount) {
            await (0, timer_1.timer)(2000);
            await this.fetch(`https://api.linkedin.com/v2/socialActions/${decodeURIComponent(id)}/comments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${integration.token}`,
                },
                body: JSON.stringify({
                    actor: `urn:li:organization:${integration.internalId}`,
                    object: id,
                    message: {
                        text: this.fixText(fields.post),
                    },
                }),
            });
            return true;
        }
        return false;
    }
};
exports.LinkedinPageProvider = LinkedinPageProvider;
tslib_1.__decorate([
    (0, plug_decorator_1.Plug)({
        identifier: 'linkedin-page-autoRepostPost',
        title: 'Auto Repost Posts',
        description: 'When a post reached a certain number of likes, repost it to increase engagement (1 week old posts)',
        runEveryMilliseconds: 21600000,
        totalRuns: 3,
        fields: [
            {
                name: 'likesAmount',
                type: 'number',
                placeholder: 'Amount of likes',
                description: 'The amount of likes to trigger the repost',
                validation: /^\d+$/,
            },
        ],
    }),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", [Object, String, Object]),
    tslib_1.__metadata("design:returntype", Promise)
], LinkedinPageProvider.prototype, "autoRepostPost", null);
tslib_1.__decorate([
    (0, plug_decorator_1.Plug)({
        identifier: 'linkedin-page-autoPlugPost',
        title: 'Auto plug post',
        description: 'When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion',
        runEveryMilliseconds: 21600000,
        totalRuns: 3,
        fields: [
            {
                name: 'likesAmount',
                type: 'number',
                placeholder: 'Amount of likes',
                description: 'The amount of likes to trigger the repost',
                validation: /^\d+$/,
            },
            {
                name: 'post',
                type: 'richtext',
                placeholder: 'Post to plug',
                description: 'Message content to plug',
                validation: /^[\s\S]{3,}$/g,
            },
        ],
    }),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", [Object, String, Object]),
    tslib_1.__metadata("design:returntype", Promise)
], LinkedinPageProvider.prototype, "autoPlugPost", null);
exports.LinkedinPageProvider = LinkedinPageProvider = tslib_1.__decorate([
    (0, rules_description_decorator_1.Rules)('LinkedIn can have maximum one attachment when selecting video, when choosing a carousel on LinkedIn minimum amount of attachment must be two, and only pictures, if uploading a video, LinkedIn can have only one attachment')
], LinkedinPageProvider);
//# sourceMappingURL=linkedin.page.provider.js.map