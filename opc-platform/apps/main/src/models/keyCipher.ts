import { safeStorage } from 'electron';

/**
 * API keys at rest.
 *
 * Uses the OS keychain (macOS Keychain / Windows DPAPI / libsecret on Linux) via
 * Electron `safeStorage`. If the platform cannot encrypt, we refuse to store the
 * key rather than writing plaintext to the database.
 */
export function encryptSecret(plain: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统密钥环不可用，无法安全保存 API Key');
  }
  return safeStorage.encryptString(plain);
}

export function decryptSecret(ciphertext: Buffer): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统密钥环不可用，无法读取 API Key');
  }
  return safeStorage.decryptString(ciphertext);
}
