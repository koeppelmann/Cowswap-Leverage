'use client';

import { useRouter } from 'next/navigation';
import { ConnectButton } from '../../components/ConnectButton';
import { RwaNetworkSwitcher } from '../../components/RwaNetworkSwitcher';
import { StocksTab } from '../../components/StocksTab';

// Standalone tokenized-RWA site (rwa.koeppelmann.dev) — only the RWA terminal,
// none of the swap/limit/twap/sDAI tabs. Rows open a full-screen asset page.
export default function RwaHome() {
  const router = useRouter();
  return (
    <div className="container wide">
      <div className="topbar">
        <div className="brand"><h1>🐮 RWA</h1><span className="tag">tokenized real-world assets</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a className="tag" href="https://swap.cow.fi" target="_blank" rel="noopener noreferrer">Powered by CoW ↗</a>
          <RwaNetworkSwitcher />
          <ConnectButton hideChainSwitcher />
        </div>
      </div>
      <StocksTab onOpenAsset={(t) => router.push(`/rwa/${encodeURIComponent(t)}`)} />
      <p className="hint center" style={{ marginTop: 18 }}>
        Trade tokenized stocks, ETFs, gold and treasuries on Ethereum via CoW Protocol.
        {/* Absolute link to the main host — on rwa.* the root path rewrites to /rwa. */}
        <a href="https://cowswap.koeppelmann.dev" style={{ marginLeft: 8 }}>Full Cowswap Pro →</a>
      </p>
    </div>
  );
}
