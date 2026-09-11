'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { wagmiConfig } from '../lib/wagmi';

export function Providers({ children }: { children: ReactNode }) {
  // Sane defaults so wagmi/on-chain reads don't refetch on every remount or window
  // focus (the default is staleTime:0 + refetchOnWindowFocus:true → constant refetching).
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 30 * 60_000, refetchOnWindowFocus: false, retry: 1 } },
  }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
