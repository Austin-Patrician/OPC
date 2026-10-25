import { shell } from 'electron';
import type { AuthInteraction, AuthPrompt, AuthType, Models } from '@earendil-works/pi-ai';
import type { FileCredentialStore } from './credentialStore';

export interface AuthPromptRequest {
  id: string;
  kind: AuthPrompt['type'];
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

export interface AuthBridge {
  /** Ask the renderer for input; resolves with its answer or rejects on cancel. */
  ask(request: AuthPromptRequest): Promise<string | null>;
  /** Tell the renderer what is happening (URL opened, device code, info). */
  notify(text: string, url?: string): void;
}

/**
 * Runs pi's provider-owned login flow.
 *
 * pi supplies the OAuth implementation (PKCE, device codes, token exchange), so we
 * only have to answer its prompts and persist the credential — which
 * `Models.login()` does through the injected `CredentialStore`.
 */
export class AuthService {
  constructor(
    private readonly createModels: () => Promise<Models>,
    private readonly store: FileCredentialStore,
  ) {}

  async login(providerId: string, type: AuthType, bridge: AuthBridge): Promise<{ ok: boolean; message: string }> {
    const models = await this.createModels();
    let counter = 0;

    const interaction: AuthInteraction = {
      prompt: async (prompt) => {
        counter += 1;
        const answer = await bridge.ask({
          id: `${providerId}-${counter}`,
          kind: prompt.type,
          message: prompt.message,
          placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
          options: prompt.type === 'select' ? prompt.options : undefined,
        });
        if (answer === null) throw new Error('登录已取消');
        return answer;
      },
      notify: (event) => {
        if (event.type === 'auth_url') {
          void shell.openExternal(event.url);
          bridge.notify(event.instructions ?? '已在浏览器中打开授权页面', event.url);
        } else if (event.type === 'device_code') {
          void shell.openExternal(event.verificationUri);
          bridge.notify(`设备码：${event.userCode}（已打开 ${event.verificationUri}）`, event.verificationUri);
        } else {
          bridge.notify(event.message);
        }
      },
    };

    try {
      await models.login(providerId, type, interaction);
      return { ok: true, message: type === 'oauth' ? 'OAuth 登录成功' : 'API Key 已保存' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async logout(providerId: string): Promise<{ ok: boolean; message: string }> {
    try {
      await this.store.delete(providerId);
      return { ok: true, message: '已退出登录' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(): Promise<{ providerId: string; type: string }[]> {
    const list = await this.store.list();
    return list.map((entry) => ({ providerId: entry.providerId, type: entry.type }));
  }
}
