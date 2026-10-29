/**
 * Extension ids contain dots, which i18next reads as nesting — map them to the
 * flat keys the locale files use. Shared by 技能与工具 and the employee stack
 * editor so both name the same extension the same way.
 */
export const EXTENSION_KEY: Record<string, string> = {
  'opc.work': 'work',
  'coding-tools': 'coding',
  'opc.sandbox': 'sandbox',
  'opc.limits': 'limits',
  'opc.image': 'image',
  'opc.speech': 'speech',
  'opc.ocr': 'ocr',
  'opc.memory': 'memory',
  'opc.comm': 'comm',
  'opc.decompose': 'decompose',
};

/** Translation key for an extension's title, or `null` when it is unregistered. */
export function extensionTitleKey(name: string): string | null {
  const key = EXTENSION_KEY[name];
  return key ? `capabilities.extensions.${key}.title` : null;
}

/** Translation key for an extension's description, or `null` when unregistered. */
export function extensionDescriptionKey(name: string): string | null {
  const key = EXTENSION_KEY[name];
  return key ? `capabilities.extensions.${key}.description` : null;
}
