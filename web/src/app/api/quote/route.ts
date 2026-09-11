import { NextResponse } from 'next/server';
import { cowBase } from '../../../lib/cowApiBase';

const COW_NETWORK: Record<number, string> = {
  1: 'mainnet',
  100: 'xdai',
};

// Short-lived cache + in-flight de-dupe of identical quote requests. Quoting many
// token versions (the overview grid, a detail page's versions) bursts the CoW
// quote API and trips its rate limit (429). Indicative prices tolerate a few
// seconds of staleness, and a request keyed on exact amount/tokens/appData is
// safe to share, so collapsing duplicates within the window cuts upstream load
// without changing what any single quote returns.
type QuoteResult = { sellAmount: string; buyAmount: string; feeAmount: string };
const CACHE_TTL = 60_000;
const qCache = new Map<string, { at: number; data: QuoteResult }>();
const qFlight = new Map<string, Promise<QuoteResult>>();

// Server-side proxy to CoW's quote API: avoids browser CORS and keeps the
// eip1271 request shape in one place.
export async function POST(req: Request) {
  let body: {
    chainId?: number;
    sellToken?: string;
    buyToken?: string;
    from?: string;
    sellAmount?: string; // before fee, base units
    appData?: string; // full appData JSON — include hooks so the fee reflects hook gas
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const { chainId, sellToken, buyToken, from, sellAmount, appData } = body;
  const network = chainId != null ? COW_NETWORK[chainId] : undefined;
  if (!network) return NextResponse.json({ error: 'unsupported chain' }, { status: 400 });
  if (!sellToken || !buyToken || !sellAmount || !from) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 });
  }

  const { url, headers } = cowBase(network);
  const appDataStr = appData ?? '{}';
  const key = `${network}|${sellToken}|${buyToken}|${from}|${sellAmount}|${appDataStr}`;

  const hit = qCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return NextResponse.json(hit.data);

  // A concurrent identical quote is in flight — await it instead of firing another.
  const running = qFlight.get(key);
  if (running) {
    try { return NextResponse.json(await running); }
    catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 502 }); }
  }

  const task = (async (): Promise<QuoteResult> => {
    const r = await fetch(`${url}/api/v1/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        sellToken,
        buyToken,
        from,
        receiver: from,
        sellAmountBeforeFee: sellAmount,
        kind: 'sell',
        signingScheme: 'eip1271',
        onchainOrder: false,
        // Passing the full appData (with post-hooks) makes CoW price the hook gas
        // into feeAmount/buyAmount — essential for hook orders to be fillable.
        appData: appDataStr,
      }),
      cache: 'no-store',
    });
    const data = await r.json();
    if (!r.ok) {
      const err = new Error(data?.description || data?.errorType || 'quote failed') as Error & { status?: number };
      err.status = r.status;
      throw err;
    }
    const q = data.quote ?? {};
    return { sellAmount: q.sellAmount as string, buyAmount: q.buyAmount as string, feeAmount: q.feeAmount as string };
  })();
  qFlight.set(key, task);

  try {
    const data = await task;
    if (qCache.size > 500) qCache.delete(qCache.keys().next().value as string);
    qCache.set(key, { at: Date.now(), data });
    return NextResponse.json(data);
  } catch (e) {
    // Don't cache failures (incl. 429) — the next call retries immediately.
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 502 });
  } finally {
    qFlight.delete(key);
  }
}
