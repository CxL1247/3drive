// Netlify serverless function — proxies external API calls to bypass CORS
// Deployed automatically at /.netlify/functions/proxy

const ALLOWED_ORIGINS = [
  'https://api.coinbase.com',
  'https://api.coingecko.com',
  'https://api.binance.com',
];

exports.handler = async function(event) {
  const target = event.queryStringParameters && event.queryStringParameters.url;

  if (!target) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing url parameter' }),
    };
  }

  // Security: only allow requests to known crypto APIs
  const allowed = ALLOWED_ORIGINS.some(o => target.startsWith(o));
  if (!allowed) {
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Origin not allowed' }),
    };
  }

  try {
    const response = await fetch(target, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': '3DriveScanner/1.0',
      },
    });

    const text = await response.text();

    return {
      statusCode: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET',
        'Cache-Control': 'no-cache',
      },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
