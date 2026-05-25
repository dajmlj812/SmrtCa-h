# SmrtCash Cookie Notice

> **DRAFT — NOT YET IN EFFECT.** This document is a draft prepared for legal review.

**Effective date**: 2026-05-25
**Last updated**: 2026-05-25

This notice describes the cookies and similar technologies that SmrtCash (operated by **BuildITSmrt LLC**) uses, and what each one does. It supplements our [Privacy Policy](/privacy).

## What is a cookie?

A cookie is a small piece of text that a website asks your browser to store. The browser sends it back to the site on each subsequent request, which lets the site recognize you across page loads. Cookies can be "first-party" (set by the site you're visiting) or "third-party" (set by a different domain that the site embeds).

## What cookies does SmrtCash use?

SmrtCash uses **only strictly-necessary cookies**. We do **not** use cookies for analytics, advertising, retargeting, social-media tracking, or any other non-essential purpose. We do not embed third-party tracking pixels.

The current full list:

| Cookie | Set by | Purpose | Type | Duration |
|---|---|---|---|---|
| `smrtcash_session` | SmrtCash (first-party) | Keeps you signed in. Without this cookie, you would have to log in on every page load. Signed (HMAC) so it cannot be forged; flagged `HttpOnly`, `Secure`, `SameSite=Strict` for security. | Strictly necessary | Up to 7 days from sign-in (refreshed on each sign-in); cleared on sign-out |
| `__cf_bm` | Cloudflare (our edge provider) | Distinguishes humans from bots to keep the Service available against automated abuse. | Strictly necessary | Up to 30 minutes per visit |
| `cf_clearance` | Cloudflare | Records that a visitor has successfully completed a Cloudflare challenge. Set only if Cloudflare's bot-management system has presented a challenge that you completed. | Strictly necessary | Up to 30 days |

All other Cloudflare cookies, if present, are listed in Cloudflare's own cookie documentation at https://www.cloudflare.com/cookie-policy/.

## What we do *not* use

For clarity, none of the following are present in SmrtCash today:

- Google Analytics, Google Tag Manager, Google Ads, or any other Google tracking;
- Meta (Facebook) Pixel, Conversion API, or any Meta tracking;
- Segment, Mixpanel, Amplitude, Heap, Hotjar, FullStory, Pendo, Posthog, or similar product-analytics tools;
- LinkedIn Insight Tag, Twitter / X conversion tracking, TikTok Pixel, Pinterest Tag;
- Cross-site retargeting, "behavioral" advertising, or any advertising-related cookie;
- A/B-testing platforms that fingerprint visitors (Optimizely, VWO, Convert, etc.);
- Session-replay cookies that record what you click or type;
- Any third-party "share" widget that loads code from another origin.

If any of those are ever added, we will update this notice and notify users in advance.

## Why we don't show a "cookies banner"

Strictly-necessary cookies are exempt from the EU ePrivacy Directive's consent requirement and from the analogous rules in other jurisdictions (Article 5(3) of Directive 2002/58/EC carves out cookies "strictly necessary for the provision of [the] service explicitly requested by the user"). Because SmrtCash uses only strictly-necessary cookies, we do not display a consent banner.

If SmrtCash ever adds non-essential cookies (analytics, marketing, etc.), we will:

1. Show a consent banner before any such cookie is set;
2. Let you accept, reject, or pick categories;
3. Honor your choice by setting only what you accept;
4. Update this notice to reflect the new categories.

## How to disable cookies

You can disable cookies through your browser's settings. **If you disable the SmrtCash session cookie, you will not be able to log in or use the Service** — the cookie is what tells our servers that you're authenticated. The Cloudflare bot-management cookies serve a similar purpose for keeping the Service available against automated abuse and disabling them may cause Cloudflare to challenge or block you.

You can disable cookies entirely by following your browser's documentation:

- [Chrome](https://support.google.com/chrome/answer/95647)
- [Firefox](https://support.mozilla.org/en-US/kb/cookies-information-websites-store-on-your-computer)
- [Safari](https://support.apple.com/en-us/HT201265)
- [Edge](https://support.microsoft.com/en-us/microsoft-edge/delete-cookies-in-microsoft-edge-63947406-40ac-c3b8-57b9-2a946a29ae09)

## Local storage and similar technologies

In addition to cookies, the SmrtCash web application uses small amounts of **localStorage** in your browser to remember UI-only preferences such as which dashboard widgets are collapsed, your selected currency display, and the last category filter you used in the transactions list. This data is stored only in your browser and is never sent to our servers. You can clear it from your browser's developer tools or by clearing site data.

SmrtCash does **not** use Web SQL, IndexedDB, Service Worker storage, or browser fingerprinting techniques to track users.

## Updates to this notice

If we add a new cookie or change the purpose of an existing one, we will update this notice and adjust the effective date. For material changes (the introduction of any non-essential cookie), we will notify you by email and require your consent before setting the new cookie.

## Contact

Questions about this notice can be sent to **privacy@builditsmrt.com**.
