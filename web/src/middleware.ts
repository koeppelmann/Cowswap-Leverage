import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').toLowerCase();

  // The app moved: twap.koeppelmann.dev → cowswap.koeppelmann.dev (paths preserved).
  // API routes are exempt so anything scripted against the old host keeps working.
  if (host === 'twap.koeppelmann.dev' && !req.nextUrl.pathname.startsWith('/api/')) {
    const url = new URL(req.nextUrl.pathname + req.nextUrl.search, 'https://cowswap.koeppelmann.dev');
    return NextResponse.redirect(url, 308);
  }

  // Standalone RWA host (rwa.koeppelmann.dev): the bare root serves the RWA-only
  // terminal instead of the full Cowswap Pro app. Other paths are served as-is.
  if (host.startsWith('rwa.') && req.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL('/rwa', req.url));
  }

  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/).*)'] };
