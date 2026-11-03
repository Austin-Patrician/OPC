import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TriggerStatus } from '@opc/shared/ipc';
import { Note, Row, Section, SecretField, StatusBadge } from '../kit';

/**
 * 触发源：外部平台把事件推进来的那扇门。
 *
 * 这一节存在的理由和整页一样：**能力必须有入口**。适配器、签名校验、去重、并线都已
 * 经在代码里了，但如果界面上没有任何地方告诉你"把哪个 URL 填到 GitHub 里、
 * 密钥填什么"，那这套东西对用户来说就不存在。
 *
 * 三个决定值得写下来：
 *
 * 1. **密钥不回读**。界面只显示"配了没有"，不显示内容——它没有需要被看见的场合，
 *    而一个能读回来的地方就是一个能泄露的地方。
 * 2. **端口改了要重启**。监听是一个已经绑好的 socket，热改端口等于假装能换。所以
 *    这里老实写"重启后生效"，而不是让用户以为改完了。
 * 3. **门只在本机**。地址是 `127.0.0.1`：GitHub / 飞书 / 钉钉都在公网，要接起来还得
 *    在中间放一条隧道。我们不做的事不假装做了。
 */
const ADAPTERS = ['github', 'feishu', 'dingtalk'] as const;
type AdapterId = (typeof ADAPTERS)[number];

export function TriggerSourceSection() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TriggerStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<AdapterId, string>>({
    github: '',
    feishu: '',
    dingtalk: '',
  });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void window
      .opc!.trigger.status()
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 改一个字就落库。写的是本机 sqlite 里的几行，不是网络请求；而密钥这种东西
   * "输了但没保存"是最容易发生也最难发现的一种坏。
   *
   * 拿到的新状态只用来更新"配了没有"，不回填输入框——否则每敲一个字符就会被
   * 一次异步回包重设，光标会跳。
   */
  const save = (id: AdapterId, value: string) => {
    setDrafts((previous) => ({ ...previous, [id]: value }));
    void window.opc!.trigger.set({ secrets: { [id]: value } }).then(setStatus);
  };

  return (
    <Section title={t('settings.trigger.title')} description={t('settings.trigger.desc')}>
      {status && !status.running ? (
        <div className="px-4 pt-3">
          <Note tone="warn">{t('settings.trigger.down')}</Note>
        </div>
      ) : null}

      {ADAPTERS.map((id) => {
        const entry = status?.entries.find((candidate) => candidate.id === id);
        return (
          <Row
            key={id}
            label={t(`settings.trigger.${id}`)}
            hint={t(`settings.trigger.${id}Hint`)}
            disabled={!loaded}
          >
            <div className="flex w-full flex-col items-end gap-1.5">
              <div className="flex w-full items-center justify-end gap-2">
                <StatusBadge
                  tone={entry?.configured ? 'green' : 'gray'}
                  label={
                    entry?.configured
                      ? t('settings.trigger.configured')
                      : t('settings.trigger.notConfigured')
                  }
                />
                <div className="w-[15rem]">
                  <SecretField
                    ariaLabel={t(`settings.trigger.${id}`)}
                    value={drafts[id]}
                    onChange={(value) => save(id, value)}
                    placeholder={t('settings.trigger.secret')}
                  />
                </div>
              </div>
              {entry ? (
                <code
                  data-testid={`trigger-url-${id}`}
                  className="max-w-full truncate font-mono text-2xs text-ink-quaternary"
                >
                  {entry.url}
                </code>
              ) : null}
            </div>
          </Row>
        );
      })}

      <p className="px-4 py-3 text-xs leading-relaxed text-ink-tertiary">
        {t('settings.trigger.portHint')}
      </p>
    </Section>
  );
}
