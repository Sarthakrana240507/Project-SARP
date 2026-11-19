import { useEffect } from 'react';
import { useRouter } from 'next/router';
import '@/styles/theme.css';
import '@/styles/globals.css';
import { initTheme } from '@/lib/theme';
import AppShell, { inShell } from '@/components/shell/AppShell';

export default function App({ Component, pageProps }) {
  const router = useRouter();
  useEffect(() => { initTheme(); }, []);
  const page = <Component {...pageProps} />;
  return inShell(router.pathname) ? <AppShell>{page}</AppShell> : page;
}
