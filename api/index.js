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

    // Paginate through all results
    let allCalls = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
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
            size: pageSize,
            offset: offset,
          })
        }
      );

      if (!ringbaRes.ok) {
        const errText = await ringbaRes.text();
        console.error('Ringba API error:', errText);
        return res.status(ringbaRes.status).json({ error: errText });
      }

      const data = await ringbaRes.json();
      const page = data?.report?.records || data?.callLog?.data || data?.calls || data?.data || [];

      console.log(`Fetched page offset=${offset}, got ${page.length} records`);
      allCalls = allCalls.concat(page);

      // Stop if we got fewer than a full page
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    const calls = allCalls;

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

    // Sapphire took over Ruby's old tracking number (+12832001597) on 2026-06-18.
    // That number is split here by call date: calls BEFORE the cutover are
    // attributed to General Health Ruby ("ghr"), calls ON/AFTER are Sapphire.
    const SAPPHIRE_CUTOVER = '2026-06-18';
    const SHARED_NUMBER_KEY = 'ghr_sapphire_shared';

    const TARGET_MAP = {
      '+13412199153': 'cm',
      '+12832001597': SHARED_NUMBER_KEY,
      '+13262063499': 'pmax',
    };

    const campCalls = { cm: 0, ghr: 0, sapphire: 0, pmax: 0 };
    const campConverted = { cm: 0, ghr: 0, sapphire: 0, pmax: 0 };

    let unresolvedSharedNumberCalls = 0;

    calls.forEach(c => {
      const targetNum = c.targetNumber || c.dialedNumber || c.inboundPhoneNumber || c.toNumber || c.destination || c.number || '';
      const normalized = targetNum.startsWith('+') ? targetNum : '+1' + targetNum;
      let campKey = TARGET_MAP[normalized] || null;

      if (campKey === SHARED_NUMBER_KEY) {
        // Try a range of possible Ringba date/time fields to find the call's date.
        const callDateRaw = c.callDt || c.callDate || c.startTimeStamp || c.callStartTime ||
                             c.timestamp || c.date || c.eventTimestamp || c.inboundCallDt || '';
        const callDateStr = callDateRaw ? String(callDateRaw).slice(0, 10) : '';

        if (callDateStr) {
          campKey = callDateStr >= SAPPHIRE_CUTOVER ? 'sapphire' : 'ghr';
        } else {
          // Couldn't find a usable date field — log it so we can fix the field name,
          // and default to ghr (the older/safer bucket) rather than silently dropping it.
          unresolvedSharedNumberCalls++;
          campKey = 'ghr';
        }
      }

      if (campKey) {
        campCalls[campKey]++;
        const converted = c.isConverted === true ||
                         c.converted === true ||
                         c.hasConverted === true ||
                         c.convertedCall === true ||
                         c.isConversion === true ||
                         (c.conversionCount && c.conversionCount > 0) ||
                         (c.conversions && c.conversions > 0);
        if (converted) campConverted[campKey]++;
      }
    });

    if (unresolvedSharedNumberCalls > 0) {
      console.warn(`WARNING: ${unresolvedSharedNumberCalls} call(s) on the shared Ruby/Sapphire number had no recognizable date field — check CALL SAMPLE above for the correct field name and update callDateRaw in index.js.`);
    }

    console.log('Total calls fetched:', calls.length);
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
