import { NextResponse } from 'next/server';
import { CACHE } from '../../../lib/httpCache';
import { createPublicClient, fallback, http, type Address } from 'viem';
import { mainnet } from 'viem/chains';

export const runtime = 'nodejs';

// Ondo Global Markets shares-per-token multiplier (`sValue`). Each total-return
// token represents M underlying shares (M starts at 1.0 and grows as reinvested
// dividends/interest accrue). One shared SyntheticSharesOracle resolves every
// asset; `getSValue` reverts AssetNotFound() for assets with no accrued adjustment
// yet — which means M is exactly 1.0. We read it server-side (no browser CORS/RPC
// concerns) and cache, since it only changes on ex-dividend / corporate actions.

const ORACLE = '0x9BC39DB6fbB44B91a48b8D5A6C208B82B1741bE6' as const;
const abi = [
  { type: 'function', name: 'getSValue', stateMutability: 'view', inputs: [{ name: 'asset', type: 'address' }], outputs: [{ name: 'sValue', type: 'uint256' }, { name: 'paused', type: 'bool' }] },
] as const;

const client = createPublicClient({
  chain: mainnet,
  transport: fallback([process.env.MAINNET_RPC, 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://cloudflare-eth.com'].filter(Boolean).map((u) => http(u as string, { timeout: 8_000 }))),
});

type Entry = { m: number; paused: boolean };
const cache = new Map<string, { at: number; v: Entry }>();
const TTL = 10 * 60_000; // 10 min — multiplier only moves on corporate actions

async function readOne(token: Address): Promise<Entry> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  let v: Entry;
  try {
    const [s, paused] = (await client.readContract({ address: ORACLE, abi, functionName: 'getSValue', args: [token] })) as readonly [bigint, boolean];
    const m = Number(s) / 1e18;
    v = { m: m > 0 ? m : 1, paused };
  } catch {
    v = { m: 1, paused: false }; // AssetNotFound() (or transient) ⇒ treat as 1.0
  }
  cache.set(key, { at: Date.now(), v });
  return v;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const raw = (u.searchParams.get('tokens') || u.searchParams.get('token') || '').trim();
  if (!raw) return NextResponse.json({ error: 'no token' }, { status: 400 });
  const addrs = Array.from(new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s)))).slice(0, 100);
  if (!addrs.length) return NextResponse.json({ error: 'bad token' }, { status: 400 });
  const entries = await Promise.all(addrs.map((a) => readOne(a as Address).then((v) => [a, v] as const)));
  const out: Record<string, Entry> = {};
  for (const [a, v] of entries) out[a] = v;
  return NextResponse.json(out, { headers: CACHE.multiplier });
}
