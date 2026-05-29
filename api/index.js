const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json());

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
}));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'insurance-dashboard-proxy' });
});

app.post('/api/calls', async (req, res) => {
  try {
    const accountId = req.headers['x-ringba-account'] || process.env.RINGBA_ACCOUNT_ID;
    const apiKey = process.env.RINGBA_API_KEY || req.headers['x-ringba-key'];
    const { dateFrom, dateTo } = req.body;

    if (!accountId || !apiKey) {
      return res.status(400).json({ error: 'Missing Ringba credentials' });
    }

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
    const calls = data?.report?.records || data?.callLog?.data || data?.calls || data?.data || [];

    // Log first call to see all fields
    if (calls.length > 0) {
      console.log('CALL KEYS:', Object.keys(calls[0]).join(', '));
      console.log('CALL SAMPLE:', JSON.stringify(calls[0]));
    }

    const totalCalls = calls.length;

    const durations = calls
      .map(c => c.callLengthInSeconds || c.lengthInSeconds || c.duration || c.callDuration || c.talkTime || 0)
      .filter(d => d > 0);

    const connectedCalls = durations.length;

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
    const campConverted = { cm: 0, ghr: 0, pmax: 0 };

    calls.forEach(c => {
      const targetNum = c.targetNumber || c.dialedNumber || c.inboundPhoneNumber || c.toNumber || c.destination || c.number || '';
      const normalized = targetNum.startsWith('+') ? targetNum : '+1' + targetNum;
      const campKey = TARGET_MAP[normalized] || null;
      if (campKey) {
        campCalls[campKey]++;
        // Check every possible converted field
        const converted = c.isConverted === true ||
                         c.converted === true ||
                         c.hasConversion === true ||
                         c.convertedCall === true ||
                         c.isConversion === true ||
                         (c.conversionCount && c.conversionCount > 0) ||
                         (c.conversions && c.conversions > 0);
        if (converted) campConverted[campKey]++;
      }
    });

    console.log('campCalls:', JSON.stringify(campCalls));
    console.log('campConverted:', JSON.stringify(campConverted));

    res.json({
      totalCalls,
      connectedCalls,
      avgDurationSec,
      campCalls,
      campConverted,
      dateFrom,
      dateTo,
    });

  } catch (err) {
    console.error('Ringba proxy error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
module.exports = app;
