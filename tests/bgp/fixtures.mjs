import { execFileSync } from 'node:child_process';

export const uint = (value, size) => { const buffer = Buffer.alloc(size); buffer.writeUIntBE(value, 0, size); return buffer; };
const cat = (...parts) => Buffer.concat(parts);
export const record = (subtype, body, type = 13) => cat(uint(1790467200, 4), uint(type, 2), uint(subtype, 2), uint(body.length, 4), body);
const peer = (flags, ip, asn) => cat(uint(flags, 1), Buffer.alloc(4), Buffer.from(ip, 'hex'), uint(asn, flags & 2 ? 4 : 2));
export const peers = () => record(1, cat(Buffer.alloc(4), uint(0, 2), uint(3, 2),
  peer(2, '7bff5af4', 3491), peer(3, '200107fa0000000100000000ca28a0f4', 3491), peer(2, 'c0000201', 64500)));
export const attribute = (kind, value) => cat(uint(0x50, 1), uint(kind, 1), uint(value.length, 2), value);
export const path = (asns, kind = 2) => cat(uint(kind, 1), uint(asns.length, 1), ...asns.map(asn => uint(asn, 4)));
export const rib = (prefix, length, asns, { family = 4, index = 0, subtype = family === 4 ? 2 : 4, kind = 2, attrs } = {}) => {
  const generic = [6, 12].includes(subtype);
  const attributes = attrs ?? attribute(2, path(asns, kind));
  return record(subtype, cat(Buffer.alloc(4),
    generic ? cat(uint(family === 4 ? 1 : 2, 2), uint(1, 1), subtype === 12 ? uint(42, 4) : Buffer.alloc(0)) : Buffer.alloc(0),
    uint(length, 1), Buffer.from(prefix, 'hex').subarray(0, Math.ceil(length / 8)), uint(1, 2), uint(index, 2), uint(1790467200, 4),
    [8, 10].includes(subtype) ? uint(42, 4) : Buffer.alloc(0), uint(attributes.length, 2), attributes));
};
export const fixture = () => cat(peers(),
  rib('', 0, [3491, 3356]),
  rib('010101', 24, [3491, 3491, 13335]),
  rib('080808', 24, [3491, 15169]),
  rib('01010180', 25, [13335, 15169], { kind: 1 }),
  rib('20010db8', 32, [3491, 6939], { family: 6, index: 1 }),
  rib('ffffffff', 32, [3491, 64496]),
  rib('010101', 24, [64500, 13335], { index: 2 }));

export function compress(bytes, format = 'bz2') {
  return execFileSync('python3', ['-c', `import sys, ${format}; sys.stdout.buffer.write(${format}.compress(sys.stdin.buffer.read()))`], { input: bytes, maxBuffer: 16 * 1024 ** 2 });
}
export function byteStream(bytes, size = 97) {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + size);
    controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
    offset = end;
  } });
}
