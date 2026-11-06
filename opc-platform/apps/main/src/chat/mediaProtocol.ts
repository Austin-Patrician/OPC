import { protocol } from 'electron';
import type { Session } from 'electron';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export const CHAT_MEDIA_SCHEME = 'opc-media';
export const CHAT_MEDIA_ORIGIN = `${CHAT_MEDIA_SCHEME}://asset`;
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_AV = 200 * 1024 * 1024;
const MIME_EXT: Record<string, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif'],
  video: ['.mp4', '.webm', '.ogv'], audio: ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'],
};

export function registerChatMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: CHAT_MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
}

export function handleChatMediaProtocol(session: Session, _workspaceRoot: string): void {
  session.protocol.handle(CHAT_MEDIA_SCHEME, async (request) => {
    try {
      const u = new URL(request.url);
      const id = u.pathname.slice(1);
      const item = registrations.get(id);
      if (!item || item.expiresAt <= Date.now()) { registrations.delete(id); return new Response('not found', { status: 404 }); }
      let response: Response;
      if (item.url) {
        let remote = new URL(item.url);
        for (let i = 0; i < 6; i++) {
          if (remote.protocol !== 'https:' || await isPrivateHost(remote.hostname)) return new Response('forbidden', { status: 403 });
          response = await fetch(remote, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: { accept: `${item.kind}/*` } });
          if ([301,302,303,307,308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location) return new Response('bad redirect', { status: 502 });
            remote = new URL(location, remote); continue;
          }
          if (!response.ok) return new Response('upstream failed', { status: 502 });
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
          if (!mime.startsWith(`${item.kind}/`) || mime === 'image/svg+xml') return new Response('unsupported media type', { status: 415 });
          const max = item.kind === 'image' ? MAX_IMAGE : MAX_AV;
          const length = Number(response.headers.get('content-length') ?? 0);
          if (length > max) return new Response('too large', { status: 413 });
          const reader = response.body?.getReader();
          if (!reader) return new Response('empty response', { status: 502 });
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > max) { await reader.cancel(); return new Response('too large', { status: 413 }); }
            chunks.push(value);
          }
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const rangeHeader = request.headers.get('range');
          const range = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
          if (!range) return new Response(bytes, { headers: { 'Content-Type': mime, 'Content-Length': String(bytes.byteLength), 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' } });
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Math.min(Number(range[2]), bytes.byteLength - 1) : bytes.byteLength - 1;
          if (start > end || start >= bytes.byteLength) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${bytes.byteLength}` } });
          const headers = new Headers({ 'Content-Type': mime, 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}` });
          return new Response(bytes.slice(start, end + 1), { status: 206, headers });
        }
        return new Response('too many redirects', { status: 502 });
      }
      const file = item.file!;
      const st = statSync(file);
      const ext = path.extname(file).toLowerCase();
      const allowed = MIME_EXT[item.kind]!.includes(ext);
      const max = item.kind === 'image' ? MAX_IMAGE : MAX_AV;
      if (!allowed || st.size > max) return new Response('unsupported artifact', { status: 415 });
      const types: Record<string,string> = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.mp4':'video/mp4','.webm': item.kind === 'audio' ? 'audio/webm' : 'video/webm','.ogv':'video/ogg','.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac' };
      const range = request.headers.get('range');
      const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = 0, end = st.size - 1, status = 200;
      if (match) { start = match[1] ? Number(match[1]) : 0; end = match[2] ? Math.min(Number(match[2]), end) : end; if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } }); status = 206; }
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
      const headers = new Headers({ 'Content-Type': types[ext], 'Content-Length': String(end-start+1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
      if (status === 206) headers.set('Content-Range', `bytes ${start}-${end}/${st.size}`);
      return new Response(stream, { status, headers });
    } catch { return new Response('media unavailable', { status: 400 }); }
  });
}

export async function registerRemoteMedia(url: string, kind: 'image' | 'video' | 'audio'): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || await isPrivateHost(parsed.hostname)) throw new Error('媒体链接必须是可公开访问的 HTTPS 地址');
  const token = crypto.randomUUID();
  // Session is populated by the registrar installed below.
  rememberRegistration(token, { kind, url: parsed.href });
  return `${CHAT_MEDIA_ORIGIN}/${token}`;
}

export function registerArtifactMedia(_taskId: string, workspaceRelPath: string, relPath: string, kind: 'image' | 'video' | 'audio', workspaceRoot: string): string {
  const taskDir = path.resolve(workspaceRoot, workspaceRelPath);
  const lexicalFile = path.resolve(taskDir, relPath);
  const root = path.resolve(workspaceRoot);
  if (lexicalFile === taskDir || !lexicalFile.startsWith(`${taskDir}${path.sep}`) || !lexicalFile.startsWith(`${root}${path.sep}`)) throw new Error('artifact path escapes workspace');
  const file = realpathSync(lexicalFile);
  if (!file.startsWith(`${realpathSync(taskDir)}${path.sep}`) || !file.startsWith(`${realpathSync(root)}${path.sep}`)) throw new Error('artifact path escapes workspace');
  if (!MIME_EXT[kind]!.includes(path.extname(file).toLowerCase())) throw new Error('unsupported artifact type');
  const max = kind === 'image' ? MAX_IMAGE : MAX_AV;
  if (!statSync(file).isFile() || statSync(file).size > max) throw new Error('artifact size or type is not allowed');
  const token = crypto.randomUUID();
  rememberRegistration(token, { kind, file });
  return `${CHAT_MEDIA_ORIGIN}/${token}`;
}

const REGISTRATION_TTL_MS = 15 * 60 * 1000;
const MAX_REGISTRATIONS = 500;
const registrations = new Map<string, { kind: 'image'|'video'|'audio'; url?: string; file?: string; expiresAt: number }>();
function rememberRegistration(token: string, value: { kind: 'image'|'video'|'audio'; url?: string; file?: string }): void {
  const now = Date.now();
  for (const [key, registration] of registrations) if (registration.expiresAt <= now) registrations.delete(key);
  while (registrations.size >= MAX_REGISTRATIONS) registrations.delete(registrations.keys().next().value!);
  registrations.set(token, { ...value, expiresAt: now + REGISTRATION_TTL_MS });
}
async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  return addresses.length === 0 || addresses.some(({address}) => {
    const a=address.toLowerCase();
    if (a.includes(':')) return a==='::1'||a==='::'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe80:')||a.startsWith('::ffff:127.')||a.startsWith('::ffff:10.')||a.startsWith('::ffff:192.168.')||a.startsWith('::ffff:169.254:');
    const [x=0,y=0] = a.split('.').map(Number);
    return x===10||x===127||x===0||x===169&&y===254||x===172&&y>=16&&y<=31||x===192&&y===168||x>=224;
  });
}
