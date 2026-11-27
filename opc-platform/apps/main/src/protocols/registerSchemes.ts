import { protocol, type CustomScheme } from 'electron';
import { WALLPAPER_CUSTOM_SCHEME } from '../appearance/wallpaperProtocol';
import { CHAT_MEDIA_CUSTOM_SCHEME } from '../chat/mediaProtocol';
import { OCR_CUSTOM_SCHEME } from '../ocr/protocol';
import { DOC_CUSTOM_SCHEME } from '../preview/docProtocol';

/**
 * All custom schemes that must be registered with Chromium in a single
 * `protocol.registerSchemesAsPrivileged()` call before `app.whenReady()`.
 *
 * Electron allows calling `registerSchemesAsPrivileged` only once; calling it
 * multiple times overwrites prior registrations and breaks `fetch()` / streams.
 */
export const APP_PRIVILEGED_SCHEMES: readonly CustomScheme[] = [
  OCR_CUSTOM_SCHEME,
  CHAT_MEDIA_CUSTOM_SCHEME,
  DOC_CUSTOM_SCHEME,
  WALLPAPER_CUSTOM_SCHEME,
];

/** Registers all application custom protocols in a single privileged batch. */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([...APP_PRIVILEGED_SCHEMES]);
}
