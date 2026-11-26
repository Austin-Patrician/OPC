import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  NotificationSettingsPatch,
  NotificationStatus,
  NotificationWhen,
} from '@opc/shared/domain';
import { buttonClass, Note, PageHeader, Row, Section, Segmented, Toggle } from '../kit';

const WHEN_OPTIONS: { value: NotificationWhen; labelKey: string }[] = [
  { value: 'background', labelKey: 'settings.notifications.whenBackground' },
  { value: 'always', labelKey: 'settings.notifications.whenAlways' },
];

/** Settings → 通用 → 桌面通知 */
export function NotificationsPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);

  useEffect(() => {
    let mounted = true;
    const bridge = window.opc?.notifications;
    if (!bridge) {
      setLoading(false);
      return undefined;
    }
    void bridge
      .getStatus()
      .then((res) => {
        if (mounted) setStatus(res);
      })
      .catch((error: unknown) => {
        if (mounted) {
          setFeedback({
            tone: 'warn',
            text: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const applyPatch = async (patch: NotificationSettingsPatch) => {
    const bridge = window.opc?.notifications;
    if (!bridge || !status) return;
    const previous = status;
    setFeedback(null);
    setStatus({
      ...status,
      settings: {
        ...status.settings,
        ...patch,
        events: {
          ...status.settings.events,
          ...(patch.events ?? {}),
        },
      },
    });
    try {
      const next = await bridge.update(patch);
      setStatus(next);
    } catch (error) {
      setStatus(previous);
      setFeedback({
        tone: 'warn',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleSendTest = async () => {
    const bridge = window.opc?.notifications;
    if (!bridge || testing) return;
    setTesting(true);
    setFeedback(null);
    try {
      const result = await bridge.test();
      if (result.ok) {
        setFeedback({ tone: 'info', text: t('settings.notifications.testSent') });
      } else {
        setFeedback({
          tone: 'warn',
          text: t('settings.notifications.testFailed', {
            reason: result.reason ?? 'unknown',
          }),
        });
      }
    } catch (error) {
      setFeedback({
        tone: 'warn',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTesting(false);
    }
  };

  const settings = status?.settings;
  const supported = status?.supported ?? false;
  const controlsDisabled = loading || !settings || !supported;
  const childDisabled = controlsDisabled || !settings?.enabled;
  const attentionHint =
    status?.platform === 'darwin'
      ? t('settings.notifications.attentionHintMac')
      : status?.platform === 'win32'
        ? t('settings.notifications.attentionHintWin')
        : t('settings.notifications.attentionHintGeneric');

  return (
    <div className="space-y-5">
      <PageHeader
        crumbs={[t('settings.group.general'), t('settings.page.notifications')]}
        title={t('settings.page.notifications')}
        description={t('settings.notifications.description')}
        actions={
          <button
            type="button"
            disabled={controlsDisabled || testing}
            onClick={() => void handleSendTest()}
            className={buttonClass.secondary}
          >
            <BellRing className="size-3.5" />
            <span>{testing ? t('settings.notifications.testing') : t('settings.notifications.testButton')}</span>
          </button>
        }
      />

      {!loading && (!window.opc?.notifications || (status && !status.supported)) ? (
        <Note tone="warn">{t('settings.notifications.unsupportedNote')}</Note>
      ) : null}

      {feedback ? <Note tone={feedback.tone}>{feedback.text}</Note> : null}

      <Section
        title={t('settings.notifications.generalTitle')}
        description={t('settings.notifications.generalDescription')}
      >
        <Row
          label={t('settings.notifications.enableLabel')}
          hint={t('settings.notifications.enableHint')}
          disabled={controlsDisabled}
        >
          <Toggle
            checked={settings?.enabled ?? false}
            disabled={controlsDisabled}
            label={t('settings.notifications.enableLabel')}
            onChange={(enabled) => void applyPatch({ enabled })}
          />
        </Row>

        <Row
          label={t('settings.notifications.whenLabel')}
          hint={t('settings.notifications.whenHint')}
          disabled={childDisabled}
        >
          <Segmented
            value={settings?.when ?? 'background'}
            label={t('settings.notifications.whenLabel')}
            options={WHEN_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            onChange={(when) => void applyPatch({ when })}
          />
        </Row>
      </Section>

      <Section
        title={t('settings.notifications.eventsTitle')}
        description={t('settings.notifications.eventsDescription')}
      >
        <Row
          label={t('settings.notifications.eventNeedsActionLabel')}
          hint={t('settings.notifications.eventNeedsActionHint')}
          disabled={childDisabled}
        >
          <Toggle
            checked={settings?.events.needsAction ?? true}
            disabled={childDisabled}
            label={t('settings.notifications.eventNeedsActionLabel')}
            onChange={(needsAction) => void applyPatch({ events: { needsAction } })}
          />
        </Row>

        <Row
          label={t('settings.notifications.eventRepliesLabel')}
          hint={t('settings.notifications.eventRepliesHint')}
          disabled={childDisabled}
        >
          <Toggle
            checked={settings?.events.replies ?? true}
            disabled={childDisabled}
            label={t('settings.notifications.eventRepliesLabel')}
            onChange={(replies) => void applyPatch({ events: { replies } })}
          />
        </Row>

        <Row
          label={t('settings.notifications.eventErrorsLabel')}
          hint={t('settings.notifications.eventErrorsHint')}
          disabled={childDisabled}
        >
          <Toggle
            checked={settings?.events.errors ?? true}
            disabled={childDisabled}
            label={t('settings.notifications.eventErrorsLabel')}
            onChange={(errors) => void applyPatch({ events: { errors } })}
          />
        </Row>
      </Section>

      <Section
        title={t('settings.notifications.deliveryTitle')}
        description={t('settings.notifications.deliveryDescription')}
      >
        <Row
          label={t('settings.notifications.soundLabel')}
          hint={t('settings.notifications.soundHint')}
          disabled={childDisabled}
        >
          <Toggle
            checked={settings?.sound ?? true}
            disabled={childDisabled}
            label={t('settings.notifications.soundLabel')}
            onChange={(sound) => void applyPatch({ sound })}
          />
        </Row>

        <Row
          label={t('settings.notifications.previewLabel')}
          hint={t('settings.notifications.previewHint')}
          disabled={childDisabled}
        >
          <Toggle
            checked={settings?.showPreview ?? true}
            disabled={childDisabled}
            label={t('settings.notifications.previewLabel')}
            onChange={(showPreview) => void applyPatch({ showPreview })}
          />
        </Row>

        <Row
          label={t('settings.notifications.attentionLabel')}
          hint={attentionHint}
          disabled={childDisabled}
        >
          <Toggle
            checked={settings?.attentionCue ?? true}
            disabled={childDisabled}
            label={t('settings.notifications.attentionLabel')}
            onChange={(attentionCue) => void applyPatch({ attentionCue })}
          />
        </Row>
      </Section>
    </div>
  );
}
