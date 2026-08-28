exports.handler = async function(event) {
  if(event.httpMethod !== 'POST') return { statusCode:405, body:'Method not allowed' };
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if(!RESEND_API_KEY) return { statusCode:500, body:JSON.stringify({error:'RESEND_API_KEY not set'}) };
  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode:400, body:'Invalid JSON' }; }
  const { email, alerts, isTest } = body;
  if(!email||!alerts||!alerts.length) return { statusCode:400, body:'Missing email or alerts' };

  const signalLabel = a => a.type==='squeeze'?'◈ BB SQUEEZE':a.type==='mtf'?`★ MTF ${a.signal==='bullish'?'↑ BULL':'↓ BEAR'}`:a.signal==='bullish'?'↑ BULL 3-Drive':'↓ BEAR 3-Drive';
  const signalColor = a => a.type==='squeeze'?'#c070ff':a.signal==='bullish'?'#00c9a0':'#f04468';
  const tvUrl = (sym,tf) => { const i={'4H':'240','1H':'60','30M':'30'}; return `https://www.tradingview.com/chart/?symbol=BINANCE:${sym}USDT&interval=${i[tf.split('+')[0]]||'60'}`; };

  const rows = alerts.map(a=>`<tr style="border-bottom:1px solid #1a2840">
    <td style="padding:12px 16px"><div style="font-family:monospace;font-size:16px;font-weight:700;color:#d4e2f0">${a.token}</div><div style="font-family:monospace;font-size:11px;color:#3d5570">${a.price}</div></td>
    <td style="padding:12px 16px"><span style="font-family:monospace;font-size:13px;font-weight:700;color:${signalColor(a)}">${signalLabel(a)}</span><div style="font-family:monospace;font-size:11px;color:#3d5570">${a.tf}</div></td>
    <td style="padding:12px 16px;text-align:center"><span style="font-family:monospace;font-size:14px;font-weight:700;color:${a.confidence>=80?'#00c9a0':a.confidence>=70?'#f0a800':'#8fa8c0'}">${a.confidence}%</span></td>
    <td style="padding:12px 16px">${a.srLevel?`<span style="font-family:monospace;font-size:12px;font-weight:700;color:#f06030;background:rgba(240,96,48,0.1);padding:2px 8px;border-radius:4px">◎ ${a.srLevel.toUpperCase()}</span>`:'<span style="color:#3d5570">—</span>'}</td>
    <td style="padding:12px 16px"><a href="${tvUrl(a.token,a.tf)}" style="font-family:monospace;font-size:12px;color:#00c8f0;text-decoration:none;background:rgba(0,200,240,0.08);padding:4px 10px;border-radius:4px;border:1px solid rgba(0,200,240,0.25)">chart ↗</a></td>
  </tr>`).join('');

  const subject = isTest?'[3Drive Scanner] Test Alert':`[3Drive Scanner] ${alerts.length} signal${alerts.length>1?'s':''} detected`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#080c16;font-family:-apple-system,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="font-family:monospace;font-size:11px;color:#3d5570;letter-spacing:3px;margin-bottom:4px">3DRIVE SCANNER</div>
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#d4e2f0">${isTest?'Test Alert':`${alerts.length} Signal${alerts.length>1?'s':''} Detected`}</h1>
    <div style="font-family:monospace;font-size:12px;color:#3d5570;margin-bottom:24px">${new Date().toUTCString()}</div>
    <div style="background:#0c1220;border:1px solid #1a2840;border-radius:8px;overflow:hidden;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:#060a13;border-bottom:1px solid #1a2840">
          <th style="padding:10px 16px;text-align:left;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">TOKEN</th>
          <th style="padding:10px 16px;text-align:left;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">SIGNAL</th>
          <th style="padding:10px 16px;text-align:center;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">CONF</th>
          <th style="padding:10px 16px;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">S/R</th>
          <th style="padding:10px 16px;font-family:monospace;font-size:10px;color:#3d5570;font-weight:500">CHART</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-family:monospace;font-size:11px;color:#3d5570;text-align:center;line-height:2">signals are pattern detections, not financial advice</div>
  </div></body></html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{'Authorization':'Bearer '+RESEND_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({from:'onboarding@resend.dev',to:[email],subject,html})
    });
    const data = await res.json();
    if(!res.ok) return {statusCode:502,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:data})};
    return {statusCode:200,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({ok:true})};
  } catch(e) {
    return {statusCode:502,headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({error:e.message})};
  }
};
