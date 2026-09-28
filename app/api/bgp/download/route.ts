import { downloadBGP } from '@/src/bgp-download.mjs';

export const GET = (request: Request) => downloadBGP(request);
