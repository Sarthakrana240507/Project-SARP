import { Html, Head, Main, NextScript } from 'next/document';

// Runs before the page is painted so there is never a flash of the wrong theme.
// Same logic as lib/theme.js (kept tiny and dependency-free on purpose).
const NO_FLASH = `(function(){var r=document.documentElement;try{var p=localStorage.getItem('sarp-theme');if(p!=='light'&&p!=='dark'&&p!=='system')p='system';var d=p==='dark'||(p==='system'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);r.setAttribute('data-theme',d?'dark':'light');r.setAttribute('data-theme-pref',p);r.style.colorScheme=d?'dark':'light';}catch(e){r.setAttribute('data-theme','light');}})();`;

export default function Document() {
  return (
    <Html lang="en" data-theme="light">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#F4F6F5" />
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
