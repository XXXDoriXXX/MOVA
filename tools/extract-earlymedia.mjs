import { readFileSync, writeFileSync } from 'node:fs';

const pcapPath = process.argv[2];
const outPath = process.argv[3] || 'zadarma-early-media.wav';
if (!pcapPath) { console.error('usage: node extract-earlymedia.mjs <file.pcap> [out.wav]'); process.exit(1); }

const buf = readFileSync(pcapPath);

const magic = buf.readUInt32BE(0);
const le = magic === 0xd4c3b2a1 || magic === 0x4d3cb2a1;
const rU16 = (b, o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
const rU32 = (b, o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
const dlt = rU32(buf, 20);
console.log(`pcap: ${le ? 'LE' : 'BE'} magic, DLT=${dlt}`);

const linkLen = (payload) => {
  if (dlt === 101) return 0;
  if (dlt === 0) return 4;
  if (dlt === 113) return 16;
  if (dlt === 276) return 20;
  if (dlt === 1) {
    return rU16BEpkt(payload, 12) === 0x8100 ? 18 : 14;
  }
  return 0;
};
const rU16BEpkt = (b, o) => b.readUInt16BE(o);

const alaw = (a) => {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else { t += 0x108; t <<= seg - 1; }
  return (a & 0x80) ? t : -t;
};

const streams = new Map();
let off = 24, pkts = 0, rtpPkts = 0;
while (off + 16 <= buf.length) {
  const inclLen = rU32(buf, off + 8);
  const rec = buf.subarray(off + 16, off + 16 + inclLen);
  off += 16 + inclLen;
  pkts++;
  try {
    let p = linkLen(rec);
    if ((rec[p] >> 4) !== 4) continue;
    const ihl = (rec[p] & 0x0f) * 4;
    if (rec[p + 9] !== 17) continue;
    const udp = p + ihl;
    const srcPort = rU16BEpkt(rec, udp);
    const dstPort = rU16BEpkt(rec, udp + 2);
    if (srcPort !== 46472 && dstPort !== 58944) continue;
    const rtp = udp + 8;
    if (rtp + 12 > rec.length) continue;
    const b0 = rec[rtp];
    if ((b0 >> 6) !== 2) continue;
    const cc = b0 & 0x0f, x = (b0 >> 4) & 1;
    let hl = 12 + 4 * cc;
    if (x) hl += 4 + rU16BEpkt(rec, rtp + hl + 2) * 4;
    const pt = rec[rtp + 1] & 0x7f;
    const ssrc = rU32BEpkt(rec, rtp + 8);
    const audio = rec.subarray(rtp + hl);
    let s = streams.get(ssrc);
    if (!s) { s = { bytes: [], pt }; streams.set(ssrc, s); }
    for (const byte of audio) s.bytes.push(byte);
    rtpPkts++;
  } catch { }
}
function rU32BEpkt(b, o) { return b.readUInt32BE(o); }

console.log(`packets=${pkts} rtpAudioPackets=${rtpPkts} streams=${streams.size}`);
if (!streams.size) { console.error('No PCMA stream matched — adjust port filter.'); process.exit(1); }

const [ssrc, s] = [...streams].sort((a, b) => b[1].bytes.length - a[1].bytes.length)[0];
console.log(`chosen ssrc=0x${ssrc.toString(16)} payloadType=${s.pt} alawBytes=${s.bytes.length} (~${(s.bytes.length / 8000).toFixed(2)}s @8kHz)`);

const n = s.bytes.length;
const pcm = Buffer.alloc(n * 2);
for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, alaw(s.bytes[i]))), i * 2);

const wav = Buffer.alloc(44 + pcm.length);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
writeFileSync(outPath, wav);
console.log(`wrote ${outPath} (${wav.length} bytes)`);
