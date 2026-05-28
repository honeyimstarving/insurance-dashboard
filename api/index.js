// ══════════════════════════════════════════════════════════════════
//  PROXY SERVER — api/index.js
//  Deploy to Vercel (free). This keeps your API keys off the browser.
//
//  SETUP:
//  1. npm install && vercel deploy
//  2. Set env vars in Vercel dashboard (or .env.local for local dev):
//     GOOGLE_ADS_DEVELOPER_TOKEN=...
//     RINGBA_API_KEY=...
//     ALLOWED_ORIGIN=https://your-dashboard-url.netlify.app
//
//  LOCAL DEV:
//  npm run dev  →  http://localhost:3000
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json());

// Allow your dashboard origin
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
}));

// ── Health check ──────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'insurance-dashboard-proxy' });
});

// ══════════════════════════════════════════════════════════════════
//  GOOGLE ADS PROXY
//  POST /api/google-ads
//  Body: { dateFrom: "2026-05-26", dateTo: "2026-05-26" }
//  Headers: x-gads-customer-id, x-gads-oauth-token
//  (developer token comes from env — never from client)
// ══════════════════════════════════════════════════════════════════
app.post('/api/google-ads', async (req, res) => {
  try {
    const customerId = req.headers['x-gads-customer-id']?.replace(/-/g, '');
    const oauthToken = req.headers['x-gads-oauth-token'];
    const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const { dateFrom, dateTo } = req.body;

    if (!customerId || !oauthToken || !developerToken) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    // Google Ads Query Language (GAQL)
    const query = `
      SELECT
        campaign.name,
        campaign.status,
        metrics.cost_micros,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${dateFrom}' AND '${dateTo}'
      ORDER BY metrics.cost_micros DESC
    `;

    const gaadsRes = await fetch(
      `https://googleads.googleapis.com/v16/customers/${customerId}/googleAds:search`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${oauthToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!gaadsRes.ok) {
      const errText = await gaadsRes.text();
      console.error('Google Ads API error:', errText);
      return res.status(gaadsRes.status).json({ error: errText });
    }

    const data = await gaadsRes.json();
    const rows = data.results || [];

    // Aggregate totals
    let totalSpend = 0, totalClicks = 0, totalImpressions = 0, totalConversions = 0;
    const campaignMap = {};

    rows.forEach(row => {
      const spend = (row.metrics?.costMicros || 0) / 1_000_000;
      const clicks = row.metrics?.clicks || 0;
      const impressions = row.metrics?.impressions || 0;
      const conversions = row.metrics?.conversions || 0;
      const name = row.campaign?.name || 'Unknown';
      const status = row.campaign?.status || 'UNKNOWN';

      totalSpend += spend;
      totalClicks += clicks;
      totalImpressions += impressions;
      totalConversions += conversions;

      if (!campaignMap[name]) {
        campaignMap[name] = { name, status, spend: 0, clicks: 0, impressions: 0, conversions: 0 };
      }
      campaignMap[name].spend += spend;
      campaignMap[name].clicks += clicks;
      campaignMap[name].impressions += impressions;
      campaignMap[name].conversions += conversions;
    });

    res.json({
      spend: Math.round(totalSpend * 100) / 100,
      clicks: totalClicks,
      impressions: totalImpressions,
      conversions: Math.round(totalConversions * 100) / 100,
      campaigns: Object.values(campaignMap),
      dateFrom,
      dateTo,
    });

  } catch (err) {
    console.error('Google Ads proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  RINGBA CALL TRACKING PROXY
//  POST /api/calls
//  Body: { dateFrom, dateTo }
//  Headers: x-ringba-account, x-ringba-key (or use env vars)
//
//  Ringba docs: https://help.ringba.com/api
//  Replace with CTM if using Call Tracking Metrics instead.
// ══════════════════════════════════════════════════════════════════
app.post('/api/calls', async (req, res) => {
  try {
    const accountId = req.headers['x-ringba-account'] || process.env.RINGBA_ACCOUNT_ID;
    const apiKey = process.env.RINGBA_API_KEY || req.headers['x-ringba-key'];
    const { dateFrom, dateTo } = req.body;

    if (!accountId || !apiKey) {
      return res.status(400).json({ error: 'Missing Ringba credentials' });
    }

    // Ringba call log endpoint — POST with date filter in body
    const ringbaRes = await fetch(
      `https://api.ringba.com/v2/${accountId}/calllogs`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reportStart: `${dateFrom}T00:00:00Z`,
          reportEnd:   `${dateTo}T23:59:59Z`,
          size: 1000,
          offset: 0,
        })
      }
    );

    if (!ringbaRes.ok) {
      const errText = await ringbaRes.text();
      console.error('Ringba API error:', errText);
      return res.status(ringbaRes.status).json({ error: errText });
    }

    const data = await ringbaRes.json();

    // Ringba returns data under callLog.data[]
    console.log('Ringba raw response:', JSON.stringify(data).slice(0, 500));
    const calls = data?.callLog?.data || data?.calls || data?.data || [];

    const totalCalls = data?.callLog?.totalCount ?? calls.length;

    const connectedCalls = calls.filter(c => {
      const dur = c.callLengthInSeconds || c.duration || c.callDuration || 0;
      return dur > 0;
    }).length;

    const durations = calls
      .map(c => c.callLengthInSeconds || c.duration || c.callDuration || 0)
      .filter(d => d > 0);

    const avgDurationSec = durations.length > 0
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    // Target-to-campaign mapping
    const TARGET_MAP = {
      '+13412199153': 'cm',
      '+12832001597': 'ghr',
      '+13262063499': 'pmax',
    };

    const campCalls = { cm: 0, ghr: 0, pmax: 0 };
    const campConnected = { cm: 0, ghr: 0, pmax: 0 };

    calls.forEach(c => {
      const targetNum = c.targetNumber || c.dialedNumber || c.toNumber || c.destination || '';
      const normalized = targetNum.startsWith('+') ? targetNum : '+1' + targetNum;
      const campKey = TARGET_MAP[normalized] || null;
      if (campKey) {
        campCalls[campKey]++;
        const dur = c.callLengthInSeconds || c.duration || c.callDuration || 0;
        if (dur > 0) campConnected[campKey]++;
      }
    });

    res.json({
      totalCalls,
      connectedCalls,
      avgDurationSec,
      campCalls,
      campConnected,
      dateFrom,
      dateTo,
    });

  } catch (err) {
    console.error('Ringba proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  CTM (CALL TRACKING METRICS) — Alternative to Ringba
//  Uncomment and use instead of Ringba above if you use CTM
// ══════════════════════════════════════════════════════════════════
/*
app.post('/api/calls-ctm', async (req, res) => {
  try {
    const accountId = process.env.CTM_ACCOUNT_ID;
    const authKey = process.env.CTM_AUTH_KEY;
    const authSecret = process.env.CTM_AUTH_SECRET;
    const { dateFrom, dateTo } = req.body;

    const credentials = Buffer.from(`${authKey}:${authSecret}`).toString('base64');

    const ctmRes = await fetch(
      `https://api.calltrackingmetrics.com/api/v1/accounts/${accountId}/calls.json?start_date=${dateFrom}&end_date=${dateTo}&per_page=250`,
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
        }
      }
    );

    const data = await ctmRes.json();
    const calls = data.calls || [];

    const totalCalls = data.total_count || calls.length;
    const connectedCalls = calls.filter(c => c.duration > 0).length;
    const avgDurationSec = calls.length > 0
      ? Math.round(calls.reduce((s, c) => s + (c.duration || 0), 0) / calls.length)
      : 0;

    res.json({ totalCalls, connectedCalls, avgDurationSec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
*/

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));

module.exports = app;
