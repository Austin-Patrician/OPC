import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import feishuSvg from '@/shared/icons/mcp/飞书.svg';
import dingtalkSvg from '@/shared/icons/mcp/钉钉.svg';
import wecomSvg from '@/shared/icons/mcp/企业微信.svg';
import figmaSvg from '@/shared/icons/mcp/figma-color.svg';
import firecrawlSvg from '@/shared/icons/mcp/firecrawl-color.svg';
import slackSvg from '@/shared/icons/channels/slack.svg';
import telegramSvg from '@/shared/icons/channels/telegram.svg';
import { cn } from '@/shared/lib/cn';

const faviconCache = new Map<string, string | null>();
const faviconPending = new Map<string, Promise<string | null>>();

type BuiltInSiteKind =
  | { type: 'github' }
  | { type: 'img'; src: string };

const BUILTIN_DOMAIN_ASSETS: readonly { suffixes: readonly string[]; icon: BuiltInSiteKind }[] = [
  { suffixes: ['github.com', 'githubusercontent.com', 'github.io'], icon: { type: 'github' } },
  { suffixes: ['feishu.cn', 'larksuite.com', 'larkoffice.com'], icon: { type: 'img', src: feishuSvg } },
  { suffixes: ['dingtalk.com'], icon: { type: 'img', src: dingtalkSvg } },
  { suffixes: ['work.weixin.qq.com'], icon: { type: 'img', src: wecomSvg } },
  { suffixes: ['slack.com'], icon: { type: 'img', src: slackSvg } },
  { suffixes: ['t.me', 'telegram.org'], icon: { type: 'img', src: telegramSvg } },
  { suffixes: ['figma.com'], icon: { type: 'img', src: figmaSvg } },
  { suffixes: ['firecrawl.dev'], icon: { type: 'img', src: firecrawlSvg } },
];

function extractRequestHost(href: string, fallbackDomain?: string): string | null {
  try {
    const host = new URL(href).hostname.replace(/\.+$/, '').toLowerCase();
    if (host) return host;
  } catch {
    // Fall back to domain prop if href is incomplete or already bare.
  }
  const clean = fallbackDomain?.trim().replace(/\.+$/, '').toLowerCase();
  return clean || null;
}

function matchBuiltInSite(host: string): BuiltInSiteKind | null {
  const normalized = host.replace(/^www\./, '');
  for (const entry of BUILTIN_DOMAIN_ASSETS) {
    if (entry.suffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`))) {
      return entry.icon;
    }
  }
  return null;
}

function fetchSiteFavicon(host: string): Promise<string | null> {
  if (faviconCache.has(host)) {
    return Promise.resolve(faviconCache.get(host) ?? null);
  }
  const existing = faviconPending.get(host);
  if (existing) return existing;

  const getFavicon = window.opc?.app?.getFavicon;
  if (!getFavicon) return Promise.resolve(null);

  const pending = getFavicon(host)
    .then((result) => {
      const safeSrc = typeof result === 'string' && result.startsWith('data:image/') ? result : null;
      faviconCache.set(host, safeSrc);
      return safeSrc;
    })
    .catch(() => {
      faviconCache.set(host, null);
      return null;
    })
    .finally(() => {
      faviconPending.delete(host);
    });

  faviconPending.set(host, pending);
  return pending;
}

/**
 * Renders an authentic site icon for external URL chips:
 * built-in brand SVGs immediately when known, otherwise cached real favicons via main-process IPC,
 * gracefully falling back to `Globe` while loading or offline.
 */
export function SiteFavicon({
  href,
  domain,
  className,
}: {
  href: string;
  domain?: string;
  className?: string;
}) {
  const requestHost = extractRequestHost(href, domain);
  const builtIn = requestHost ? matchBuiltInSite(requestHost) : null;

  const [resolved, setResolved] = useState<{ host: string; src: string | null } | null>(null);
  const [brokenHost, setBrokenHost] = useState<string | null>(null);

  const cachedSrc = requestHost ? faviconCache.get(requestHost) : undefined;
  const activeSrc =
    cachedSrc !== undefined
      ? cachedSrc
      : resolved?.host === requestHost
        ? resolved.src
        : null;
  const isBroken = Boolean(requestHost && brokenHost === requestHost);

  useEffect(() => {
    if (!requestHost || builtIn || cachedSrc !== undefined) return undefined;
    if (!window.opc?.app?.getFavicon) return undefined;

    let cancelled = false;
    void fetchSiteFavicon(requestHost).then((src) => {
      if (!cancelled) {
        setResolved({ host: requestHost, src });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [builtIn, cachedSrc, requestHost]);

  if (builtIn?.type === 'github') {
    return (
      <svg
        viewBox="0 0 1024 1024"
        fill="currentColor"
        aria-hidden="true"
        className={cn('size-3 shrink-0 text-ink/80', className)}
      >
        <path d="M511.6 76.3C264.3 76.2 64 276.4 64 523.5 64 718.9 189.3 885 363.8 946c23.5 5.9 19.9-10.8 19.9-22.2v-77.5c-135.7 15.9-141.2-73.9-150.3-88.9C215 726 171.5 718 184.5 703c30.9-15.9 62.4 4 98.9 57.9 26.4 39.1 77.9 32.5 104 26 5.7-23.5 17.9-44.5 34.7-60.8-140.6-25.2-199.2-111-199.2-213 0-49.5 16.3-95 48.3-131.7-20.4-60.5 1.9-112.3 4.9-120 58.1-5.2 118.5 41.6 123.2 45.3 33-8.9 70.7-13.6 112.9-13.6 42.4 0 80.2 4.9 113.5 13.9 11.3-8.6 67.3-48.8 121.3-43.9 2.9 7.7 24.7 58.3 5.5 118 32.4 36.8 48.9 82.7 48.9 132.3 0 102.2-59 188.1-200 212.9 23.5 23.2 38.1 55.4 38.1 91v112.5c0.8 9 0 17.9 15 17.9 177.1-59.7 304.6-227 304.6-424.1 0-247.2-200.4-447.3-447.5-447.3z" />
      </svg>
    );
  }

  if (builtIn?.type === 'img') {
    return (
      <img
        src={builtIn.src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('size-3.5 shrink-0 rounded-[2px] object-contain', className)}
      />
    );
  }

  if (activeSrc && !isBroken && requestHost) {
    return (
      <img
        src={activeSrc}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBrokenHost(requestHost)}
        className={cn('size-3.5 shrink-0 rounded-[2px] object-contain', className)}
      />
    );
  }

  return <Globe className={cn('size-3 shrink-0 opacity-80', className)} aria-hidden="true" />;
}
