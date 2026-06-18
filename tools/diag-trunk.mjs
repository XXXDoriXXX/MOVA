import 'dotenv/config';
import { SipClient } from 'livekit-server-sdk';

const TARGET = process.env.SIP_TRUNK_ID || 'ST_Kzfa49iQkqHF';

const ENC = { 0: 'DISABLE (clean RTP)', 1: 'ALLOW (offer both)', 2: 'REQUIRE (force SRTP)' };
const TRANSPORT = { 0: 'AUTO', 1: 'UDP', 2: 'TCP', 3: 'TLS' };

const redact = (t) => {
  const o = { ...t };
  for (const k of ['authPassword', 'password', 'outboundPassword']) {
    if (o[k]) o[k] = `***set(${String(o[k]).length} chars)***`;
  }
  return o;
};

const wss = process.env.LIVEKIT_URL;
if (!wss) { console.error('LIVEKIT_URL missing'); process.exit(1); }
const httpUrl = wss.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
const client = new SipClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);

try {
  const trunks = await client.listSipOutboundTrunk();
  console.log(`Found ${trunks.length} outbound trunk(s). Target = ${TARGET}\n`);

  const target = trunks.find((t) => t.sipTrunkId === TARGET);
  if (!target) {
    console.log('!! TARGET NOT FOUND. Trunk ids present:', trunks.map((t) => t.sipTrunkId));
  } else {
    console.log('=== TARGET TRUNK (full, redacted) ===');
    console.log(JSON.stringify(redact(target), null, 2));
    console.log('\n=== DECODED ===');
    console.log('transport       :', TRANSPORT[target.transport] ?? `raw(${target.transport})`);
    console.log('mediaEncryption :', ENC[target.mediaEncryption] ?? `raw(${target.mediaEncryption})`);
    console.log('address         :', target.address);
    console.log('numbers         :', target.numbers);
    console.log('destinationCountry:', target.destinationCountry ?? '(unset)');
  }
} catch (e) {
  console.error('ERROR calling LiveKit:', e?.message || e);
  console.error('(method listSipOutboundTrunk on SipClient — if missing, SDK version differs)');
  process.exit(1);
}
