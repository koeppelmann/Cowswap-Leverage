'use client';

import { useEffect, useRef, useState } from 'react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { mainnet } from 'wagmi/chains';

// RWA is Ethereum-mainnet only today. The switcher stays visible and lists the
// other CoW-supported chains that host RWA as "coming soon" (disabled).
const OTHER_CHAINS: { name: string; color: string }[] = [
  { name: 'Base', color: '#0052ff' },
  { name: 'Arbitrum One', color: '#28a0f0' },
  { name: 'Gnosis', color: '#3e6957' },
  { name: 'Polygon', color: '#8247e5' },
  { name: 'Avalanche', color: '#e84142' },
];
const ETH = '#627eea';

export function RwaNetworkSwitcher() {
  const [open, setOpen] = useState(false);
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChain } = useSwitchChain();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selectEth = () => {
    if (isConnected && chainId !== mainnet.id) switchChain({ chainId: mainnet.id });
    setOpen(false);
  };

  return (
    <div className="net-switch" ref={ref}>
      <button className="net-btn" onClick={() => setOpen((o) => !o)}>
        <span className="net-dot" style={{ background: ETH }} /> Ethereum <span className="net-chev">▾</span>
      </button>
      {open && (
        <div className="net-menu">
          <button className="net-item on" onClick={selectEth}>
            <span className="net-dot" style={{ background: ETH }} /> Ethereum <span className="net-live">Live</span>
          </button>
          {OTHER_CHAINS.map((c) => (
            <div key={c.name} className="net-item soon" aria-disabled>
              <span className="net-dot" style={{ background: c.color }} /> {c.name} <span className="net-soon">Coming soon</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
