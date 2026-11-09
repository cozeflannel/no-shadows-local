// Alert texts for the bot tests. The first three are the Burson V3 alerts already used by
// tests/test_production_artifacts.py; the last two are Burson V3 alerts in the full layout (banner, header line,
// boilerplate), one correct and one with four mistakes.
'use strict';

const AIO = `THIS ALERT MEETS P1 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 12, 2026, 1:47 AM
[Exposure Tag]: Product - Factual inaccuracies (not dangerous/offensive)
[Product]: AI Overviews (AIM, Web Guide)
[Other Google Products]: Search
[Engagement]: HIGH (29425 engagements)
[Sensitive Topic]: None
[KOF]: No
An X user (@TheChiefNerd; 284712 followers) shared a screenshot of a Google Search query in which the AI Overview incorrectly stated that a historical treaty was signed in 1998 rather than 1898. Commenters are mocking AI Overviews for basic historical errors.
[Link]: https://x.com/TheChiefNerd/status/1845000000000000001
[Name]: AI Overviews Historical Treaty Date Error / New / not previously reported over the past 14 days
[Code]: Product - Factual inaccuracies (not dangerous/offensive),29425,@TheChiefNerd,None,AI Overviews (AIM, Web Guide),New / not previously reported over the past 14 days`;

const MAPS = `THIS ALERT MEETS P2 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 12, 2026, 3:15 AM
[Exposure Tag]: Product - Memes & humorous content
[Product]: Maps
[Other Google Products]: None
[Engagement]: HIGH (4200 engagements)
[Sensitive Topic]: None
[KOF]: No
A Reddit user (u/map_enthusiast) on r/GoogleMaps posted a humorous screenshot of Street View capturing a dog chasing the Google Maps car.
[Link]: https://www.reddit.com/r/GoogleMaps/comments/1abcde/street_view_dog/
[Name]: Google Maps Street View Dog Meme / New / not previously reported over the past 14 days
[Code]: Product - Memes & humorous content,4200,u/map_enthusiast,None,Maps,New / not previously reported over the past 14 days`;

const PARIS = `THIS ALERT MEETS P0 CRITERIA
SOCIAL ALERT:
[Time/Date Post Went Live]: October 12, 2026, 5:40 AM
[Exposure Tag]: Product - Dangerous/offensive results
[Product]: Search
[Other Google Products]: AI Overviews (AIM, Web Guide)
[Engagement]: LOW (340 engagements)
[Sensitive Topic]: Violence & Gore, World Politics
[KOF]: Yes (Tech Journalists)
A French journalist (@paris_tech_press; 95000 followers) in Paris, France posted a screenshot showing Google Search autocomplete suggesting violent queries related to ongoing protests in Paris.
[Link]: https://x.com/paris_tech_press/status/1845000000000000003
[Name]: Search Autocomplete Violent Suggestions in Paris / New / not previously reported over the past 14 days
[Code]: Product - Dangerous/offensive results,340,@paris_tech_press,Violence & Gore,Search,New / not previously reported over the past 14 days`;

const P0_OK = `🚨THIS ALERT MEETS P0 CRITERIA🚨

⬛SOCIAL ALERT⬛: Search | Alleged Bias in Search Reporting for Paris Riots 2026 | X | 1 Engagements
[Name]: Alleged Bias in Search Reporting for Paris Riots 2026 / New / not previously reported over the past 14 days
[Engagement]: VERY LOW (1 engagements)
[Product]: Search
[Social Network]: X
[Exposure Tag]: Product - Perceived bias
[Sensitive Topic]: -
[KOF]: No

X user @WasSamLowryEsq (652 followers) criticized Search for allegedly presenting a curated selection of results for “Paris riots 2026,” claiming that the results mainly showed white protesters. The user accused Google of contributing to a misleading account of events.

[Link]: https://x.com/WasSamLowryEsq/status/2109952063492993159

As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social's 24/7 Social Listening & Rapid Response. Please consider removing these aliases in NTK replies.

[Time/Date Post Went Live]: October 13, 2026, 3:19 AM

[Code]: Product - Perceived bias,1,WasSamLowryEsq,-,Search,New / not previously reported over the past 14 days

Please note: screenshots are not available for Reddit, TikTok, Facebook or Instagram.`;

const MISTAKES = `THIS ALERT MEETS P2 CRITERIA

🟨SOCIAL ALERT🟨: Gems | Criticism against AI Overviews | Instagram | 29425 Engagements
[Name]: Criticism against AI Overviews / Ongoing Issue
[Engagement]: LOW (29425 engagements)
[Product]: Gems
[Social Network]: Instagram
[Exposure Tag]: Product - Perceived bias
[Sensitive Topic]: -
[KOF]: No

X user edervolcelazz (195 followers) shared a post featuring an AI Overview with an offensive reply to a crude query.

[Link]: https://x.com/edervolcelazz/status/2109566527900926417

As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
Note: Brand-Social-Sends@ and SLRR-updates@ includes xWF vendors that support Brand Social's 24/7 Social Listening & Rapid Response. Please consider removing these aliases in NTK replies.

[Time/Date Post Went Live]: October 12, 2026, 1:47 AM

[Code]: Product - Perceived bias,29425,edervolcelazz,-,Gems,Ongoing Issue

Please note: screenshots are not available for Reddit, TikTok, Facebook or Instagram.`;

/** MISTAKES as Burson would resend it after every fix. */
const MISTAKES_FIXED = MISTAKES
  .replace('THIS ALERT MEETS P2 CRITERIA', '🚨THIS ALERT MEETS P0 CRITERIA🚨')
  .replace('🟨SOCIAL ALERT🟨: Gems | Criticism against AI Overviews | Instagram |', '🟥SOCIAL ALERT🟥: Gemini App | Criticism against AI Overviews | X |')
  .replace('[Engagement]: LOW', '[Engagement]: HIGH')
  .replace('[Product]: Gems', '[Product]: Gemini App')
  .replace('[Social Network]: Instagram', '[Social Network]: X')
  .replace(',Gems,Ongoing Issue', ',Gemini App,Ongoing Issue');

/** MISTAKES resent with everything fixed except the engagement level. */
const MISTAKES_PARTLY_FIXED = MISTAKES_FIXED
  .replace('[Engagement]: HIGH', '[Engagement]: LOW')
  .replace('🟥SOCIAL ALERT🟥', '🟨SOCIAL ALERT🟨');

/** P0_OK without its link (only Burson can supply it), and the resend that adds it. */
const NO_LINK = P0_OK.replace('[Link]: https://x.com/WasSamLowryEsq/status/2109952063492993159\n', '');
const NO_LINK_RESENT = P0_OK;

/**
 * A KOF alert as Burson really writes it (2026-10-18, dated within this week): [KOF] names the author's list, Engagement
 * is the count's level. The IM sent it to the Waymo POCs and GCPA (📦 📰).
 */
const WAYMO_KOF = `THIS ALERT MEETS P2 CRITERIA
⭐ SOCIAL ALERT ⭐: Waymo | Criticism against Waymo | X | 11 Engagements
[Name]: Criticism against Waymo / Ongoing Issue
[Engagement]: VERY LOW (11 engagements)
[Product]: Waymo
[Social Network]: X
[Exposure Tag]: Product - Other/general criticism
[Sensitive Topic]: -
[KOF]: Viral KOFs (KOFs)
X user ICannot_Enough (307.1K followers) shared a video criticizing Waymo's autonomous vehicle operations and technical infrastructure. The author alleges that Waymo relies on "remote employees in the Philippines to resolve driving situations," claiming that the vehicles "freeze and obstruct traffic."
[Link]: https://x.com/ICannot_Enough/status/2111814207448514693
As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
[Time/Date Post Went Live]: 10/13/2026,6:40 AM
[Code]: Product - Other/general criticism,11,ICannot_Enough,-,Waymo,Ongoing Issue`;

/** The same author's follow-up on that post, 2 hours later: the IM didn't action it (the original was already alerted). */
const WAYMO_FOLLOW_UP = `THIS ALERT MEETS P2 CRITERIA
⭐ SOCIAL ALERT ⭐: Waymo | Criticism against Waymo | X | 1 Engagements
[Name]: Criticism against Waymo / Ongoing Issue
[Engagement]: VERY LOW (1 engagement)
[Product]: Waymo
[Social Network]: X
[Exposure Tag]: Product - Other/general criticism
[Sensitive Topic]: -
[KOF]: Viral KOFs (KOFs)
X user ICannot_Enough (307.1K followers) shared a follow-up post questioning whether Waymo's nighttime assistance calls are handled by representatives in the U.S. or the Philippines. The author tags Grok, asking the AI platform to address alleged inaccurate claims from a previously discussed video regarding Waymo's remote operations.
[Link]: https://x.com/ICannot_Enough/status/2111840627885252950
As a reminder, all alerts can be found in our Alert Dashboard at go/SLRR-Database.
[Time/Date Post Went Live]: 10/13/2026,8:23 AM
[Code]: Product - Other/general criticism,1,ICannot_Enough,-,Waymo,Ongoing Issue`;

module.exports = { AIO, MAPS, PARIS, P0_OK, MISTAKES, MISTAKES_FIXED, MISTAKES_PARTLY_FIXED, NO_LINK, NO_LINK_RESENT, WAYMO_KOF, WAYMO_FOLLOW_UP };
