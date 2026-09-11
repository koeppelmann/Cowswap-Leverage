'use client';

import { ConnectButton } from '../../../components/ConnectButton';
import { RwaNetworkSwitcher } from '../../../components/RwaNetworkSwitcher';
import { AssetView } from '../../../components/AssetView';

// Full-screen single-asset page: multi-timeframe chart + version comparison +
// trade panel + "Buy on CoW Swap" links.
export default function AssetPage({ params }: { params: { ticker: string } }) {
  const { ticker } = params;
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
      <AssetView ticker={decodeURIComponent(ticker).toUpperCase()} backHref="/rwa" />
    </div>
  );
}
