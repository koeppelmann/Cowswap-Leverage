import {
  type Address, type PublicClient, type WalletClient,
  keccak256, maxUint256, toHex,
} from 'viem';
import { mainnet } from 'viem/chains';
import { erc20Abi } from './abi';
import { GPV2_ORDER_TYPES } from './carrier';
import { fetchQuote } from './quote';
import { buildPermitHook } from './sdaiPermit';
import { getChainConfig } from './chains';

const SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41' as const;
const APP_CODE = 'koeppelmann/stocks';

async function postCow(body: unknown) {
  const r = await fetch('/api/cow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export type CowSwapResult = { uid: string };

/**
 * Execute a MEV-protected CoW swap on Ethereum mainnet with a GASLESS EIP-2612
 * permit when the sell token supports it (else a one-time approve). Quotes WITH the
 * permit pre-hook so the price reflects reality. Returns the order uid.
 *
 * @param onStatus optional progress callback for UI ("Signing…", "Approving…").
 */
export async function cowSwap(opts: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  owner: Address;
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  slippageBps: number;
  validSecs?: number;
  onStatus?: (s: string) => void;
}): Promise<CowSwapResult> {
  const { publicClient, walletClient, owner, sellToken, buyToken, sellAmount, slippageBps } = opts;
  const status = opts.onStatus ?? (() => {});
  const relayer = getChainConfig(mainnet.id)!.vaultRelayer;

  // Approval: prefer a gasless permit pre-hook; fall back to on-chain approve.
  let permitHook: Awaited<ReturnType<typeof buildPermitHook>> | undefined;
  const allowance = await publicClient.readContract({ address: sellToken, abi: erc20Abi, functionName: 'allowance', args: [owner, relayer] }) as bigint;
  if (allowance < sellAmount) {
    status('Sign a gasless approval (permit)…');
    permitHook = (await buildPermitHook({ client: publicClient, walletClient, token: sellToken, owner, chainId: mainnet.id })) ?? undefined;
    if (!permitHook) {
      status('One-time approval on Ethereum…');
      const h = await walletClient.writeContract({ address: sellToken, abi: erc20Abi, functionName: 'approve', args: [relayer, maxUint256], account: owner, chain: mainnet });
      await publicClient.waitForTransactionReceipt({ hash: h });
    }
  }

  const appDoc = JSON.stringify({
    appCode: APP_CODE, version: '1.6.0',
    metadata: permitHook ? { hooks: { pre: [{ target: permitHook.target, callData: permitHook.callData, gasLimit: permitHook.gasLimit }], post: [] } } : {},
  });
  const appHash = keccak256(toHex(appDoc));

  status('Quoting…');
  const q = await fetchQuote({ chainId: mainnet.id, sellToken, buyToken, from: owner, sellAmount, appData: appDoc });
  const buyMin = (q.buyAmount * BigInt(10_000 - Math.max(0, Math.min(10_000, slippageBps)))) / 10_000n;
  if (buyMin <= 0n) throw new Error('quote too low');

  const validTo = Math.floor(Date.now() / 1000) + (opts.validSecs ?? 1800);
  const order = {
    sellToken, buyToken, receiver: owner,
    sellAmount: sellAmount.toString(), buyAmount: buyMin.toString(),
    validTo, appData: appHash, feeAmount: '0', kind: 'sell', partiallyFillable: false,
    sellTokenBalance: 'erc20', buyTokenBalance: 'erc20',
  };
  status('Sign your order…');
  const sig = await walletClient.signTypedData({
    account: owner, domain: { name: 'Gnosis Protocol', version: 'v2', chainId: mainnet.id, verifyingContract: SETTLEMENT },
    types: GPV2_ORDER_TYPES, primaryType: 'Order',
    message: { ...order, sellAmount, buyAmount: buyMin, validTo: BigInt(validTo), feeAmount: 0n } as never,
  });
  await postCow({ chainId: mainnet.id, kind: 'appData', appDataHash: appHash, fullAppData: appDoc });
  const os = await postCow({ chainId: mainnet.id, kind: 'order', order: { ...order, signingScheme: 'eip712', signature: sig, from: owner } });
  if (!os.ok || !os.uid) throw new Error('order rejected: ' + (os.raw || os.status));
  return { uid: os.uid };
}
