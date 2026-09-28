export function parseIP(input) {
  const text = input.trim().toLowerCase();
  if (!text.includes(':')) {
    const parts = text.split('.');
    if (parts.length !== 4 || parts.some(p => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) throw new Error('请输入有效的 IPv4 或 IPv6 地址。');
    return { family: 4, value: parts.reduce((value, p) => value * 256n + BigInt(p), 0n) };
  }
  let expanded = text;
  if (text.includes('.')) {
    const colon = text.lastIndexOf(':');
    const { value } = parseIP(text.slice(colon + 1));
    expanded = `${text.slice(0, colon)}:${(value >> 16n).toString(16)}:${(value & 65535n).toString(16)}`;
  }
  const halves = expanded.split('::');
  if (halves.length > 2) throw new Error('IPv6 地址格式无效。');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1) ||
      [...left, ...right].some(p => !/^[0-9a-f]{1,4}$/.test(p))) throw new Error('IPv6 地址格式无效。');
  return { family: 6, value: [...left, ...Array(missing).fill('0'), ...right].reduce((value, p) => (value << 16n) | BigInt(`0x${p}`), 0n) };
}

export function formatIP(value, family) {
  if (family === 4) return [24n, 16n, 8n, 0n].map(shift => Number((value >> shift) & 255n)).join('.');
  const parts = Array.from({ length: 8 }, (_, i) => ((value >> BigInt((7 - i) * 16)) & 65535n).toString(16));
  let best = -1, length = 1;
  for (let i = 0; i < 8;) {
    if (parts[i] !== '0') { i++; continue; }
    const start = i;
    while (i < 8 && parts[i] === '0') i++;
    if (i - start > length) { best = start; length = i - start; }
  }
  return best < 0 ? parts.join(':') : `${parts.slice(0, best).join(':')}::${parts.slice(best + length).join(':')}`;
}

export function bytesToBigInt(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function prefixKey(value, family, length) {
  const shift = BigInt((family === 4 ? 32 : 128) - length);
  const masked = (value >> shift) << shift;
  // IPv6 network addresses share zero low bits. BigInt Map keys can cause
  // severe hash collisions in V8; hexadecimal keys keep insertion/lookup fast.
  return family === 4 ? Number(masked) : masked.toString(16);
}
